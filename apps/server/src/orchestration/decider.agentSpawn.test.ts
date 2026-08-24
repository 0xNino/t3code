import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-agent-spawn");

const projectCreated: OrchestrationEvent = {
  sequence: 1,
  eventId: EventId.make("evt-project-agent-spawn"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("cmd-project-agent-spawn"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-project-agent-spawn"),
  metadata: {},
  payload: {
    projectId,
    title: "Agent orchestration",
    workspaceRoot: "/tmp/t3code",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
};

it.layer(NodeServices.layer)("decider agent spawn", (it) => {
  it.effect("creates a normal thread while preserving durable ownership metadata", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), projectCreated);
      const childId = ThreadId.make("agent-review-1");
      const parentId = ThreadId.make("thread-parent");

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.spawn",
          commandId: CommandId.make("server:agent-spawn:review-1"),
          threadId: childId,
          projectId,
          title: "Architecture reviewer · Claude Opus",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: "feat/agent-orchestration",
          worktreePath: "/tmp/t3code",
          spawn: {
            parentThreadId: parentId,
            spawnId: "review-1",
            depth: 1,
            allowDelegation: false,
            creatorProviderSessionId: "provider-session-1",
            role: "architecture-reviewer",
          },
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.created");
      expect(event.metadata.agentSpawn).toEqual({
        parentThreadId: parentId,
        spawnId: "review-1",
        depth: 1,
        allowDelegation: false,
        creatorProviderSessionId: "provider-session-1",
        role: "architecture-reviewer",
      });

      const projected = yield* projectEvent(readModel, { ...event, sequence: 2 });
      const thread = projected.threads.find((candidate) => candidate.id === childId);
      expect(thread).toMatchObject({
        id: childId,
        projectId,
        title: "Architecture reviewer · Claude Opus",
        runtimeMode: "approval-required",
        branch: "feat/agent-orchestration",
        worktreePath: "/tmp/t3code",
      });
    }),
  );
});
