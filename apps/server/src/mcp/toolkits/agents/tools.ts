import {
  ModelSelection,
  ProviderInstanceId,
  ServerProviderModel,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";

export const AGENT_RUN_MAX_BATCH = 8;
export const AGENT_PROMPT_MAX_CHARS = 120_000;
export const AGENT_WAIT_MAX_MS = 60_000;

const described = <S extends Schema.Top>(schema: S, description: string): S =>
  schema.annotate({ description }) as S;

export const AgentSpec = Schema.Struct({
  prompt: described(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(AGENT_PROMPT_MAX_CHARS)),
    "Complete task or review prompt to send to this child agent.",
  ),
  modelSelection: described(
    ModelSelection,
    "Exact configured provider instance, model slug, and optional provider-specific model options.",
  ),
  title: Schema.optional(
    described(
      TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      "Short title shown for the child thread in T3 Code.",
    ),
  ),
  role: Schema.optional(
    described(
      TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      "Workflow role such as standards-reviewer, architecture-reviewer, or researcher.",
    ),
  ),
  allowDelegation: Schema.optional(
    described(
      Schema.Boolean,
      "Whether this child may itself start child agents. Defaults to false.",
    ),
  ),
  idempotencyKey: Schema.optional(
    described(
      TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      "Stable caller-generated key. Retrying start with the same key reuses the same child and first turn.",
    ),
  ),
});
export type AgentSpec = typeof AgentSpec.Type;

const AgentSessionIds = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(AGENT_RUN_MAX_BATCH),
);

export const AgentRunInput = Schema.Struct({
  operation: described(
    Schema.Literals(["start", "poll", "wait", "steer", "cancel"]),
    "Action to perform: start a batch, poll or wait for owned children, send a follow-up, or cancel turns.",
  ),
  agents: Schema.optional(
    described(
      Schema.Array(AgentSpec).check(Schema.isMinLength(1), Schema.isMaxLength(AGENT_RUN_MAX_BATCH)),
      "Child specifications. Required only for start.",
    ),
  ),
  sessionIds: Schema.optional(
    described(AgentSessionIds, "Owned child thread ids. Required for poll, wait, and cancel."),
  ),
  sessionId: Schema.optional(described(ThreadId, "One owned child thread id. Required for steer.")),
  prompt: Schema.optional(
    described(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(AGENT_PROMPT_MAX_CHARS)),
      "Follow-up prompt. Required for steer.",
    ),
  ),
  timeoutMs: Schema.optional(
    described(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_WAIT_MAX_MS })),
      "Maximum wait in milliseconds. Only used by wait; defaults to 30000 and never exceeds 60000.",
    ),
  ),
});

export const AgentSessionState = Schema.Literals([
  "idle",
  "starting",
  "running",
  "completed",
  "interrupted",
  "error",
  "stopped",
]);

export const AgentSessionSummary = Schema.Struct({
  sessionId: ThreadId,
  parentThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  role: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  state: AgentSessionState,
  sessionStatus: Schema.optional(TrimmedNonEmptyString),
  turnState: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastError: Schema.optional(TrimmedNonEmptyString),
  reused: Schema.optional(Schema.Boolean),
});
export type AgentSessionSummary = typeof AgentSessionSummary.Type;

export const AgentRunResult = Schema.Struct({
  operation: Schema.Literals(["start", "poll", "wait", "steer", "cancel"]),
  sessions: Schema.Array(AgentSessionSummary),
  timedOut: Schema.optional(Schema.Boolean),
});

export const AgentManageInput = Schema.Struct({
  operation: described(
    Schema.Literals(["list_agents", "list_sessions", "get_log", "cleanup_sessions"]),
    "Discovery or inspection action: list configured agents, list owned children, read a transcript, or archive finished children.",
  ),
  sessionId: Schema.optional(
    described(ThreadId, "One owned child thread id. Required for get_log."),
  ),
  sessionIds: Schema.optional(
    described(AgentSessionIds, "Owned child thread ids. Required for cleanup_sessions."),
  ),
  maxChars: Schema.optional(
    described(
      Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 100_000 })),
      "Maximum transcript characters returned by get_log. Defaults to 20000.",
    ),
  ),
});

export const AgentProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  available: Schema.Boolean,
  status: TrimmedNonEmptyString,
  authStatus: TrimmedNonEmptyString,
  models: Schema.Array(ServerProviderModel),
});

export const AgentLogMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: Schema.String,
});

export const AgentLog = Schema.Struct({
  sessionId: ThreadId,
  messages: Schema.Array(AgentLogMessage),
  truncated: Schema.Boolean,
});

export const AgentManageResult = Schema.Struct({
  operation: Schema.Literals(["list_agents", "list_sessions", "get_log", "cleanup_sessions"]),
  providers: Schema.optional(Schema.Array(AgentProvider)),
  sessions: Schema.optional(Schema.Array(AgentSessionSummary)),
  log: Schema.optional(AgentLog),
  archivedSessionIds: Schema.optional(Schema.Array(ThreadId)),
});

export const AgentControlFailureReason = Schema.Literals([
  "capability-disabled",
  "invalid-input",
  "not-found",
  "not-owned",
  "delegation-disabled",
  "limit-exceeded",
  "provider-unavailable",
  "session-busy",
  "internal-error",
]);
export type AgentControlFailureReason = typeof AgentControlFailureReason.Type;

export class AgentControlError extends Schema.TaggedErrorClass<AgentControlError>()(
  "AgentControlError",
  {
    operation: TrimmedNonEmptyString,
    reason: AgentControlFailureReason,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  ProviderRegistry,
  Crypto.Crypto,
];

export const AgentRunTool = Tool.make("agent_run", {
  description:
    "Start and control provider-neutral child agents as ordinary visible T3 Code threads. Children are scoped to this parent thread, persist across restarts, and can be monitored from the sidebar while the parent continues working.",
  parameters: AgentRunInput,
  success: AgentRunResult,
  failure: AgentControlError,
  dependencies,
})
  .annotate(Tool.Title, "Run child agents")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const AgentManageTool = Tool.make("agent_manage", {
  description:
    "Discover configured provider instances and models, inspect child-agent sessions and transcripts owned by this parent thread, or archive explicitly selected finished children.",
  parameters: AgentManageInput,
  success: AgentManageResult,
  failure: AgentControlError,
  dependencies,
})
  .annotate(Tool.Title, "Manage child agents")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const AgentToolkit = Toolkit.make(AgentRunTool, AgentManageTool);
