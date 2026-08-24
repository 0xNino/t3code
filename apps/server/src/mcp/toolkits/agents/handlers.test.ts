import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { __testing } from "./handlers.ts";

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
