// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { __testing } from "./handlers.ts";
import { AGENT_REVIEW_WORKSPACE_MARKER, AGENT_REVIEW_WORKSPACE_MARKER_CONTENT } from "./tools.ts";

const record = (threadId: string, parentThreadId: string, depth: number) => ({
  threadId: ThreadId.make(threadId),
  createdAt: `2026-01-01T00:00:0${depth}.000Z`,
  spawn: {
    parentThreadId: ThreadId.make(parentThreadId),
    spawnId: threadId,
    depth,
    allowDelegation: false,
    creatorProviderSessionId: `provider-${depth}`,
  },
});

it("recognizes direct and transitive ownership without crossing parent trees", () => {
  const direct = record("agent-direct", "thread-parent", 1);
  const nested = record("agent-nested", "agent-direct", 2);
  const foreign = record("agent-foreign", "thread-foreign", 1);
  const records = new Map([
    [direct.threadId, direct],
    [nested.threadId, nested],
    [foreign.threadId, foreign],
  ]);

  expect(__testing.isDescendantOf(records, ThreadId.make("thread-parent"), direct.threadId)).toBe(
    true,
  );
  expect(__testing.isDescendantOf(records, ThreadId.make("thread-parent"), nested.threadId)).toBe(
    true,
  );
  expect(__testing.isDescendantOf(records, ThreadId.make("thread-parent"), foreign.threadId)).toBe(
    false,
  );
  expect(__testing.ownedRecords(records, ThreadId.make("thread-parent"))).toEqual([direct, nested]);
});

it("terminates safely when malformed ownership metadata contains a cycle", () => {
  const first = record("agent-cycle-a", "agent-cycle-b", 1);
  const second = record("agent-cycle-b", "agent-cycle-a", 2);
  const records = new Map([
    [first.threadId, first],
    [second.threadId, second],
  ]);

  expect(__testing.isDescendantOf(records, ThreadId.make("thread-parent"), first.threadId)).toBe(
    false,
  );
});

it.effect("accepts only marked review snapshots under T3's configured review directory", () =>
  Effect.gen(function* () {
    const snapshotsDirectory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-snapshots-test-")),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const workspace = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(snapshotsDirectory, "seer-review-test-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(workspace, AGENT_REVIEW_WORKSPACE_MARKER),
        `${AGENT_REVIEW_WORKSPACE_MARKER_CONTENT}\n`,
        "utf8",
      ),
    );

    expect(yield* __testing.validateReviewWorkspace(workspace, snapshotsDirectory)).toBe(
      yield* Effect.promise(() => NodeFSP.realpath(workspace)),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects an unmarked directory under T3's review root", () =>
  Effect.gen(function* () {
    const snapshotsDirectory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-snapshots-test-")),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const workspace = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(snapshotsDirectory, "seer-review-test-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const error = yield* __testing
      .validateReviewWorkspace(workspace, snapshotsDirectory)
      .pipe(Effect.flip);
    expect(error.reason).toBe("invalid-input");
    expect(error.detail).toContain(AGENT_REVIEW_WORKSPACE_MARKER);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a marked snapshot elsewhere in the operating-system temp directory", () =>
  Effect.gen(function* () {
    const snapshotsDirectory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-snapshots-test-")),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const workspace = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-test-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(workspace, AGENT_REVIEW_WORKSPACE_MARKER),
        `${AGENT_REVIEW_WORKSPACE_MARKER_CONTENT}\n`,
        "utf8",
      ),
    );

    const error = yield* __testing
      .validateReviewWorkspace(workspace, snapshotsDirectory)
      .pipe(Effect.flip);
    expect(error.reason).toBe("invalid-input");
    expect(error.detail).toContain("configured T3 Code review directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);
