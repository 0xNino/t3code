import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AgentManageInput, AgentRunInput, AgentRunResult } from "./tools.ts";

const decodeRun = Schema.decodeUnknownEffect(AgentRunInput);
const decodeManage = Schema.decodeUnknownEffect(AgentManageInput);
const encodeRunResult = Schema.encodeUnknownEffect(AgentRunResult);

it.effect("accepts an exact provider/model selection with reasoning options", () =>
  Effect.gen(function* () {
    const input = yield* decodeRun({
      operation: "start",
      agents: [
        {
          prompt: "Review the change without modifying files.",
          modelSelection: {
            instanceId: "claudeAgent",
            model: "claude-opus-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          role: "architecture-reviewer",
          idempotencyKey: "architecture-review-v1",
        },
      ],
    });

    expect(input.operation).toBe("start");
    expect(input.agents?.[0]?.modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  }),
);

it.effect("accepts only the constrained review workspace fields", () =>
  Effect.gen(function* () {
    const input = yield* decodeRun({
      operation: "start",
      agents: [
        {
          prompt: "Review only.",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          access: "read-only",
          workspacePath: "/tmp/sanitized-review",
          cwd: "/tmp/ignored",
          runtimeMode: "full-access",
        },
      ],
    });

    expect(input.agents?.[0]).toMatchObject({
      access: "read-only",
      workspacePath: "/tmp/sanitized-review",
    });
    expect(input.agents?.[0]).not.toHaveProperty("cwd");
    expect(input.agents?.[0]).not.toHaveProperty("runtimeMode");
  }),
);

it.effect("bounds wait duration and transcript size", () =>
  Effect.gen(function* () {
    expect((yield* Effect.exit(decodeRun({ operation: "wait", timeoutMs: 60_001 })))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* Effect.exit(
        decodeManage({ operation: "get_log", sessionId: "agent-1", maxChars: 100_001 }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("reports the semantic read-only mode in child summaries", () =>
  Effect.gen(function* () {
    const encoded = yield* encodeRunResult({
      operation: "start",
      sessions: [
        {
          sessionId: ThreadId.make("agent-read-only"),
          parentThreadId: ThreadId.make("thread-parent"),
          title: "Read-only review",
          modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
          runtimeMode: "read-only",
          state: "running",
          createdAt: "2026-08-25T00:00:00.000Z",
          updatedAt: "2026-08-25T00:00:00.000Z",
        },
      ],
    });

    expect(encoded.sessions[0]?.runtimeMode).toBe("read-only");
  }),
);
