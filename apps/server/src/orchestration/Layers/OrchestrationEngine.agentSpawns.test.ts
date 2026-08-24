import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";

import type { OrchestrationAgentSpawnRecord } from "../Services/OrchestrationEngine.ts";
import { indexAgentSpawnEvents } from "./OrchestrationEngine.ts";

const createdEvent = (
  sequence: number,
  threadId: ThreadId,
  parentThreadId?: ThreadId,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.created",
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`command-${sequence}`),
  metadata:
    parentThreadId === undefined
      ? {}
      : {
          agentSpawn: {
            parentThreadId,
            spawnId: `spawn-${sequence}`,
            depth: 1,
            allowDelegation: false,
            creatorProviderSessionId: "provider-session-1",
          },
        },
  payload: {
    threadId,
    projectId: ProjectId.make("project-1"),
    title: `Thread ${sequence}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

it("indexes only child-agent creation events", () => {
  const parentId = ThreadId.make("thread-parent");
  const childId = ThreadId.make("agent-child");
  const ordinaryId = ThreadId.make("thread-ordinary");
  const records = new Map<ThreadId, OrchestrationAgentSpawnRecord>();

  indexAgentSpawnEvents(records, [createdEvent(1, childId, parentId), createdEvent(2, ordinaryId)]);

  expect(records.get(childId)?.spawn.parentThreadId).toBe(parentId);
  expect(records.size).toBe(1);
  expect(records.has(ordinaryId)).toBe(false);
});
