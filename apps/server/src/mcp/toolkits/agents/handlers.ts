import * as NodeOS from "node:os";

import {
  CommandId,
  MessageId,
  ThreadId,
  type AgentSpawnMetadata,
  type ModelSelection,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  OrchestrationEngineService,
  type OrchestrationAgentSpawnRecord,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import {
  AgentControlError,
  AGENT_REVIEW_WORKSPACE_MARKER,
  AGENT_REVIEW_WORKSPACE_MARKER_CONTENT,
  AgentToolkit,
  type AgentControlFailureReason,
  type AgentSessionSummary,
  type AgentSpec,
} from "./tools.ts";

const MAX_AGENT_DEPTH = 2;
const MAX_AGENT_DESCENDANTS = 32;
const MAX_ACTIVE_AGENT_DESCENDANTS = 8;
const DEFAULT_WAIT_MS = 30_000;

const fail = (operation: string, reason: AgentControlFailureReason, detail: string) =>
  new AgentControlError({ operation, reason, detail });

const isAgentControlError = Schema.is(AgentControlError);

const mapFailure = (operation: string) => (cause: unknown) =>
  isAgentControlError(cause)
    ? cause
    : fail(operation, "internal-error", `Agent ${operation} failed: ${String(cause)}`);

const requireAgentCapability = Effect.fn("AgentToolkit.requireCapability")(function* (
  operation: string,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("agents")) {
    return yield* fail(
      operation,
      "capability-disabled",
      "Agent orchestration is disabled. Enable it in Settings → Integrations → Agents, then restart this provider session.",
    );
  }
  return invocation;
});

const readSpawnRecords = Effect.fn("AgentToolkit.readSpawnRecords")(function* () {
  const engine = yield* OrchestrationEngineService;
  if (engine.agentSpawnRecords === undefined) {
    return yield* fail(
      "ownership",
      "internal-error",
      "This orchestration engine does not expose child-agent ownership metadata.",
    );
  }
  return yield* engine.agentSpawnRecords;
});

function isDescendantOf(
  records: ReadonlyMap<ThreadId, OrchestrationAgentSpawnRecord>,
  ancestorId: ThreadId,
  candidateId: ThreadId,
): boolean {
  const visited = new Set<ThreadId>();
  let current = records.get(candidateId);
  while (current !== undefined && !visited.has(current.threadId)) {
    if (current.spawn.parentThreadId === ancestorId) return true;
    visited.add(current.threadId);
    current = records.get(current.spawn.parentThreadId);
  }
  return false;
}

function ownedRecords(
  records: ReadonlyMap<ThreadId, OrchestrationAgentSpawnRecord>,
  parentThreadId: ThreadId,
): ReadonlyArray<OrchestrationAgentSpawnRecord> {
  return Array.from(records.values()).filter((record) =>
    isDescendantOf(records, parentThreadId, record.threadId),
  );
}

const requireOwnedRecords = Effect.fn("AgentToolkit.requireOwnedRecords")(function* (
  operation: string,
  parentThreadId: ThreadId,
  sessionIds: ReadonlyArray<ThreadId>,
  records: ReadonlyMap<ThreadId, OrchestrationAgentSpawnRecord>,
) {
  const uniqueIds = Array.from(new Set(sessionIds));
  for (const sessionId of uniqueIds) {
    if (!isDescendantOf(records, parentThreadId, sessionId)) {
      return yield* fail(
        operation,
        records.has(sessionId) ? "not-owned" : "not-found",
        `Thread '${sessionId}' is not a child owned by this agent session.`,
      );
    }
  }
  return uniqueIds;
});

function sessionState(thread: OrchestrationThread): AgentSessionSummary["state"] {
  if (thread.latestTurn?.state === "running") return "running";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  if (thread.latestTurn?.state === "error") return "error";
  if (thread.session?.status === "starting") return "starting";
  if (thread.session?.status === "running") return "running";
  if (thread.session?.status === "error") return "error";
  if (thread.session?.status === "stopped") return "stopped";
  return "idle";
}

function toSessionSummary(
  record: OrchestrationAgentSpawnRecord,
  thread: OrchestrationThread,
  reused?: boolean,
): AgentSessionSummary {
  return {
    sessionId: thread.id,
    parentThreadId: record.spawn.parentThreadId,
    title: thread.title,
    ...(record.spawn.role === undefined ? {} : { role: record.spawn.role }),
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    ...(thread.worktreePath === null ? {} : { workspacePath: thread.worktreePath }),
    state: sessionState(thread),
    ...(thread.session === null ? {} : { sessionStatus: thread.session.status }),
    ...(thread.latestTurn === null ? {} : { turnState: thread.latestTurn.state }),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.session?.lastError === null || thread.session?.lastError === undefined
      ? {}
      : { lastError: thread.session.lastError }),
    ...(reused === undefined ? {} : { reused }),
  };
}

const readSessionSummaries = Effect.fn("AgentToolkit.readSessionSummaries")(function* (
  sessionIds: ReadonlyArray<ThreadId>,
  records: ReadonlyMap<ThreadId, OrchestrationAgentSpawnRecord>,
) {
  const query = yield* ProjectionSnapshotQuery;
  const summaries: AgentSessionSummary[] = [];
  for (const sessionId of sessionIds) {
    const detail = yield* query.getThreadDetailById(sessionId);
    const record = records.get(sessionId);
    if (Option.isSome(detail) && record !== undefined) {
      summaries.push(toSessionSummary(record, detail.value));
    }
  }
  return summaries;
});

const randomId = Effect.fn("AgentToolkit.randomId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4.pipe(Effect.orDie);
});

const digestHex = Effect.fn("AgentToolkit.digestHex")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

function pathIsInside(path: Path.Path, parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const validateReviewWorkspace = Effect.fn("AgentToolkit.validateReviewWorkspace")(function* (
  workspacePath: string,
) {
  const operation = "start";
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(workspacePath)) {
    return yield* fail(operation, "invalid-input", "workspacePath must be absolute.");
  }
  const canonicalTempRoot = yield* fileSystem
    .realPath(NodeOS.tmpdir())
    .pipe(
      Effect.mapError(() =>
        fail(
          operation,
          "internal-error",
          "The operating-system temporary directory is unavailable.",
        ),
      ),
    );
  const canonicalWorkspace = yield* fileSystem
    .realPath(workspacePath)
    .pipe(
      Effect.mapError(() =>
        fail(operation, "invalid-input", `Review workspace '${workspacePath}' does not exist.`),
      ),
    );
  if (!pathIsInside(path, canonicalTempRoot, canonicalWorkspace)) {
    return yield* fail(
      operation,
      "invalid-input",
      "A read-only review workspace must be a child of the operating-system temporary directory.",
    );
  }
  const stats = yield* fileSystem
    .stat(canonicalWorkspace)
    .pipe(
      Effect.mapError(() =>
        fail(
          operation,
          "invalid-input",
          `Review workspace '${workspacePath}' cannot be inspected.`,
        ),
      ),
    );
  if (stats.type !== "Directory") {
    return yield* fail(operation, "invalid-input", "workspacePath must identify a directory.");
  }
  const markerPath = path.join(canonicalWorkspace, AGENT_REVIEW_WORKSPACE_MARKER);
  const marker = yield* fileSystem
    .readFileString(markerPath)
    .pipe(
      Effect.mapError(() =>
        fail(
          operation,
          "invalid-input",
          `Review workspace is missing the ${AGENT_REVIEW_WORKSPACE_MARKER} attestation marker.`,
        ),
      ),
    );
  if (marker.trim() !== AGENT_REVIEW_WORKSPACE_MARKER_CONTENT) {
    return yield* fail(operation, "invalid-input", "Review workspace attestation is invalid.");
  }
  return canonicalWorkspace;
});

function findProvider(
  providers: ReadonlyArray<ServerProvider>,
  modelSelection: ModelSelection,
): { readonly provider: ServerProvider; readonly modelName: string } | undefined {
  const provider = providers.find((entry) => entry.instanceId === modelSelection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === modelSelection.model);
  return provider && model ? { provider, modelName: model.shortName ?? model.name } : undefined;
}

const spawnOne = Effect.fn("AgentToolkit.spawnOne")(function* (input: {
  readonly invocation: McpInvocationContext.McpInvocationScope;
  readonly parent: OrchestrationThread;
  readonly parentDepth: number;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly records: ReadonlyMap<ThreadId, OrchestrationAgentSpawnRecord>;
  readonly spec: AgentSpec;
  readonly spawnId: string;
  readonly threadId: ThreadId;
}) {
  const operation = "start";
  const providerMatch = findProvider(input.providers, input.spec.modelSelection);
  if (
    providerMatch === undefined ||
    providerMatch.provider.availability === "unavailable" ||
    !providerMatch.provider.enabled ||
    !providerMatch.provider.installed ||
    providerMatch.provider.status === "disabled" ||
    providerMatch.provider.auth.status === "unauthenticated"
  ) {
    return yield* fail(
      operation,
      "provider-unavailable",
      `Provider instance '${input.spec.modelSelection.instanceId}' with model '${input.spec.modelSelection.model}' is not available. Use agent_manage list_agents to inspect exact choices.`,
    );
  }
  const { spawnId, threadId } = input;
  const existingRecord = input.records.get(threadId);
  if (
    existingRecord !== undefined &&
    existingRecord.spawn.parentThreadId !== input.invocation.threadId
  ) {
    return yield* fail(
      operation,
      "not-owned",
      `The idempotent child id '${threadId}' is already owned by another parent thread.`,
    );
  }
  const reused = existingRecord !== undefined;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const role = input.spec.role;
  const access = input.spec.access ?? "supervised";
  if (input.spec.workspacePath !== undefined && access !== "read-only") {
    return yield* fail(
      operation,
      "invalid-input",
      "workspacePath is only allowed for a read-only child agent.",
    );
  }
  if (access === "read-only" && input.spec.allowDelegation === true) {
    return yield* fail(
      operation,
      "invalid-input",
      "A read-only child agent cannot be granted delegation authority.",
    );
  }
  const reviewWorkspace =
    input.spec.workspacePath === undefined
      ? undefined
      : yield* validateReviewWorkspace(input.spec.workspacePath);
  const runtimeMode = access === "read-only" ? "read-only" : "approval-required";
  const title =
    input.spec.title ??
    `${role ?? providerMatch.provider.displayName ?? providerMatch.provider.driver} · ${providerMatch.modelName}`;
  const spawn: AgentSpawnMetadata = {
    parentThreadId: input.invocation.threadId,
    spawnId,
    depth: input.parentDepth + 1,
    allowDelegation: input.spec.allowDelegation ?? false,
    creatorProviderSessionId: input.invocation.providerSessionId,
    ...(role === undefined ? {} : { role }),
  };
  const engine = yield* OrchestrationEngineService;
  if (existingRecord === undefined) {
    yield* engine.dispatch({
      type: "thread.spawn",
      commandId: CommandId.make(`server:agent-spawn:${spawnId}`),
      threadId,
      projectId: input.parent.projectId,
      title,
      modelSelection: input.spec.modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: reviewWorkspace === undefined ? input.parent.branch : null,
      worktreePath: reviewWorkspace ?? input.parent.worktreePath,
      spawn,
      createdAt,
    });
  }
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`server:agent-turn:${spawnId}:0`),
    threadId,
    message: {
      messageId: MessageId.make(`agent-message:${spawnId}:0`),
      role: "user",
      text: input.spec.prompt,
      attachments: [],
    },
    modelSelection: input.spec.modelSelection,
    titleSeed: title,
    runtimeMode,
    interactionMode: "default",
    createdAt,
  });

  const query = yield* ProjectionSnapshotQuery;
  const detail = yield* query.getThreadDetailById(threadId);
  if (Option.isNone(detail)) {
    return yield* fail(
      operation,
      "internal-error",
      `Spawned thread '${threadId}' was not projected.`,
    );
  }
  return toSessionSummary(existingRecord ?? { threadId, createdAt, spawn }, detail.value, reused);
});

const startAgents = Effect.fn("AgentToolkit.startAgents")(function* (
  agents: ReadonlyArray<AgentSpec>,
) {
  const invocation = yield* requireAgentCapability("start");
  const records = yield* readSpawnRecords();
  const parentRecord = records.get(invocation.threadId);
  if (parentRecord !== undefined && !parentRecord.spawn.allowDelegation) {
    return yield* fail(
      "start",
      "delegation-disabled",
      "This spawned child was not granted permission to delegate to more agents.",
    );
  }
  const parentDepth = parentRecord?.spawn.depth ?? 0;
  if (parentDepth >= MAX_AGENT_DEPTH) {
    return yield* fail(
      "start",
      "limit-exceeded",
      `Agent delegation depth cannot exceed ${MAX_AGENT_DEPTH}.`,
    );
  }

  const query = yield* ProjectionSnapshotQuery;
  const parent = yield* query.getThreadDetailById(invocation.threadId);
  if (Option.isNone(parent)) {
    return yield* fail("start", "not-found", "The invoking parent thread no longer exists.");
  }
  const preparedAgents = yield* Effect.forEach(agents, (spec) =>
    Effect.gen(function* () {
      const rawSpawnId =
        spec.idempotencyKey === undefined
          ? yield* randomId()
          : yield* digestHex(
              `${invocation.environmentId}\u0000${invocation.threadId}\u0000${spec.idempotencyKey}`,
            );
      const spawnId = rawSpawnId.slice(0, 64);
      return { spec, spawnId, threadId: ThreadId.make(`agent-${spawnId}`) } as const;
    }),
  );
  const newThreadIds = new Set(
    preparedAgents.map(({ threadId }) => threadId).filter((threadId) => !records.has(threadId)),
  );
  if (new Set(preparedAgents.map(({ threadId }) => threadId)).size !== preparedAgents.length) {
    return yield* fail(
      "start",
      "invalid-input",
      "Each agent in one start batch must use a distinct idempotency key.",
    );
  }
  const descendants = ownedRecords(records, invocation.threadId);
  const readModel = yield* query.getSnapshot();
  const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
  const activeCount = descendants.filter((record) => {
    const thread = threadsById.get(record.threadId);
    return thread !== undefined && ["starting", "running"].includes(sessionState(thread));
  }).length;
  const retainedCount = descendants.filter((record) => {
    const thread = threadsById.get(record.threadId);
    return thread !== undefined && thread.archivedAt === null && thread.deletedAt === null;
  }).length;
  if (retainedCount + newThreadIds.size > MAX_AGENT_DESCENDANTS) {
    return yield* fail(
      "start",
      "limit-exceeded",
      `A parent may retain at most ${MAX_AGENT_DESCENDANTS} unarchived descendant agents.`,
    );
  }
  if (activeCount + newThreadIds.size > MAX_ACTIVE_AGENT_DESCENDANTS) {
    return yield* fail(
      "start",
      "limit-exceeded",
      `A parent may run at most ${MAX_ACTIVE_AGENT_DESCENDANTS} agents concurrently.`,
    );
  }

  const providerRegistry = yield* ProviderRegistry;
  const providers = yield* providerRegistry.getProviders;
  return yield* Effect.forEach(
    preparedAgents,
    ({ spec, spawnId, threadId }) =>
      spawnOne({
        invocation,
        parent: parent.value,
        parentDepth,
        providers,
        records,
        spec,
        spawnId,
        threadId,
      }),
    { concurrency: 1 },
  );
});

const pollSessions = Effect.fn("AgentToolkit.pollSessions")(function* (
  operation: string,
  sessionIds: ReadonlyArray<ThreadId>,
) {
  const invocation = yield* requireAgentCapability(operation);
  const records = yield* readSpawnRecords();
  const ownedIds = yield* requireOwnedRecords(operation, invocation.threadId, sessionIds, records);
  return yield* readSessionSummaries(ownedIds, records);
});

const waitForSessions = Effect.fn("AgentToolkit.waitForSessions")(function* (
  sessionIds: ReadonlyArray<ThreadId>,
  timeoutMs: number,
) {
  const invocation = yield* requireAgentCapability("wait");
  const records = yield* readSpawnRecords();
  const ownedIds = yield* requireOwnedRecords("wait", invocation.threadId, sessionIds, records);
  const engine = yield* OrchestrationEngineService;

  const subscribeDomainEvents = engine.subscribeDomainEvents;
  if (subscribeDomainEvents === undefined) {
    return { sessions: yield* readSessionSummaries(ownedIds, records), timedOut: false };
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* subscribeDomainEvents;
      const initial = yield* readSessionSummaries(ownedIds, records);
      if (initial.some((session) => !["starting", "running"].includes(session.state))) {
        return { sessions: initial, timedOut: false };
      }
      const fingerprint = (sessions: ReadonlyArray<AgentSessionSummary>) =>
        sessions
          .map(({ sessionId, state, sessionStatus, turnState, lastError }) =>
            [sessionId, state, sessionStatus ?? "", turnState ?? "", lastError ?? ""].join(
              "\u0000",
            ),
          )
          .join("\u0001");
      const initialFingerprint = fingerprint(initial);
      const ownedSet = new Set(ownedIds);
      const changed = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(subscription);
          if (event.aggregateKind !== "thread" || !ownedSet.has(ThreadId.make(event.aggregateId))) {
            continue;
          }
          const next = yield* readSessionSummaries(ownedIds, records);
          const nextFingerprint = fingerprint(next);
          if (nextFingerprint !== initialFingerprint) return next;
        }
      }).pipe(Effect.timeoutOption(timeoutMs));
      return Option.isSome(changed)
        ? { sessions: changed.value, timedOut: false }
        : { sessions: yield* readSessionSummaries(ownedIds, records), timedOut: true };
    }),
  );
});

const startFollowUp = Effect.fn("AgentToolkit.startFollowUp")(function* (
  sessionId: ThreadId,
  prompt: string,
) {
  const invocation = yield* requireAgentCapability("steer");
  const records = yield* readSpawnRecords();
  yield* requireOwnedRecords("steer", invocation.threadId, [sessionId], records);
  const query = yield* ProjectionSnapshotQuery;
  const detail = yield* query.getThreadDetailById(sessionId);
  if (Option.isNone(detail)) {
    return yield* fail("steer", "not-found", `Child thread '${sessionId}' was not found.`);
  }
  if (["starting", "running"].includes(sessionState(detail.value))) {
    return yield* fail(
      "steer",
      "session-busy",
      "The child is still running. Wait or cancel it before sending a follow-up.",
    );
  }
  const suffix = yield* randomId();
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`server:agent-steer:${suffix}`),
    threadId: sessionId,
    message: {
      messageId: MessageId.make(`agent-message:${suffix}`),
      role: "user",
      text: prompt,
      attachments: [],
    },
    modelSelection: detail.value.modelSelection,
    runtimeMode: detail.value.runtimeMode,
    interactionMode: detail.value.interactionMode,
    createdAt,
  });
  return yield* readSessionSummaries([sessionId], records);
});

const cancelSessions = Effect.fn("AgentToolkit.cancelSessions")(function* (
  sessionIds: ReadonlyArray<ThreadId>,
) {
  const invocation = yield* requireAgentCapability("cancel");
  const records = yield* readSpawnRecords();
  const ownedIds = yield* requireOwnedRecords("cancel", invocation.threadId, sessionIds, records);
  const engine = yield* OrchestrationEngineService;
  for (const sessionId of ownedIds) {
    const suffix = yield* randomId();
    yield* engine.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(`server:agent-cancel:${suffix}`),
      threadId: sessionId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  }
  return yield* readSessionSummaries(ownedIds, records);
});

const listAgents = Effect.fn("AgentToolkit.listAgents")(function* () {
  yield* requireAgentCapability("list_agents");
  const registry = yield* ProviderRegistry;
  const providers = yield* registry.getProviders;
  return providers.map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    enabled: provider.enabled,
    installed: provider.installed,
    available: provider.availability !== "unavailable",
    status: provider.status,
    authStatus: provider.auth.status,
    models: provider.models,
  }));
});

const listSessions = Effect.fn("AgentToolkit.listSessions")(function* () {
  const invocation = yield* requireAgentCapability("list_sessions");
  const records = yield* readSpawnRecords();
  const owned = ownedRecords(records, invocation.threadId).toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return yield* readSessionSummaries(
    owned.map((record) => record.threadId),
    records,
  );
});

const getLog = Effect.fn("AgentToolkit.getLog")(function* (sessionId: ThreadId, maxChars: number) {
  const invocation = yield* requireAgentCapability("get_log");
  const records = yield* readSpawnRecords();
  yield* requireOwnedRecords("get_log", invocation.threadId, [sessionId], records);
  const query = yield* ProjectionSnapshotQuery;
  const detail = yield* query.getThreadDetailById(sessionId);
  if (Option.isNone(detail)) {
    return yield* fail("get_log", "not-found", `Child thread '${sessionId}' was not found.`);
  }
  const messages = detail.value.messages.map((message) => ({
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  }));
  const selected: typeof messages = [];
  let size = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (selected.length > 0 && size + message.text.length > maxChars) break;
    selected.unshift(message);
    size += message.text.length;
  }
  return {
    sessionId,
    messages: selected,
    truncated: selected.length < messages.length,
  };
});

const cleanupSessions = Effect.fn("AgentToolkit.cleanupSessions")(function* (
  sessionIds: ReadonlyArray<ThreadId>,
) {
  const invocation = yield* requireAgentCapability("cleanup_sessions");
  const records = yield* readSpawnRecords();
  const ownedIds = yield* requireOwnedRecords(
    "cleanup_sessions",
    invocation.threadId,
    sessionIds,
    records,
  );
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  for (const sessionId of ownedIds) {
    const detail = yield* query.getThreadDetailById(sessionId);
    if (Option.isSome(detail) && ["starting", "running"].includes(sessionState(detail.value))) {
      return yield* fail(
        "cleanup_sessions",
        "session-busy",
        `Child thread '${sessionId}' is still running and cannot be archived.`,
      );
    }
  }
  for (const sessionId of ownedIds) {
    const suffix = yield* randomId();
    yield* engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`server:agent-archive:${suffix}`),
      threadId: sessionId,
    });
  }
  return ownedIds;
});

const requireArray = <A>(operation: string, value: ReadonlyArray<A> | undefined, field: string) =>
  value === undefined
    ? Effect.fail(fail(operation, "invalid-input", `${field} is required for ${operation}.`))
    : Effect.succeed(value);

const handlers = {
  agent_run: (input) =>
    Effect.gen(function* () {
      switch (input.operation) {
        case "start":
          return {
            operation: input.operation,
            sessions: yield* startAgents(
              yield* requireArray(input.operation, input.agents, "agents"),
            ),
          };
        case "poll":
          return {
            operation: input.operation,
            sessions: yield* pollSessions(
              input.operation,
              yield* requireArray(input.operation, input.sessionIds, "sessionIds"),
            ),
          };
        case "wait": {
          const waited = yield* waitForSessions(
            yield* requireArray(input.operation, input.sessionIds, "sessionIds"),
            input.timeoutMs ?? DEFAULT_WAIT_MS,
          );
          return { operation: input.operation, ...waited };
        }
        case "steer":
          if (input.sessionId === undefined || input.prompt === undefined) {
            return yield* fail(
              input.operation,
              "invalid-input",
              "sessionId and prompt are required for steer.",
            );
          }
          return {
            operation: input.operation,
            sessions: yield* startFollowUp(input.sessionId, input.prompt),
          };
        case "cancel":
          return {
            operation: input.operation,
            sessions: yield* cancelSessions(
              yield* requireArray(input.operation, input.sessionIds, "sessionIds"),
            ),
          };
      }
    }).pipe(Effect.mapError(mapFailure(input.operation))),
  agent_manage: (input) =>
    Effect.gen(function* () {
      switch (input.operation) {
        case "list_agents":
          return { operation: input.operation, providers: yield* listAgents() };
        case "list_sessions":
          return { operation: input.operation, sessions: yield* listSessions() };
        case "get_log":
          if (input.sessionId === undefined) {
            return yield* fail(
              input.operation,
              "invalid-input",
              "sessionId is required for get_log.",
            );
          }
          return {
            operation: input.operation,
            log: yield* getLog(input.sessionId, input.maxChars ?? 20_000),
          };
        case "cleanup_sessions":
          return {
            operation: input.operation,
            archivedSessionIds: yield* cleanupSessions(
              yield* requireArray(input.operation, input.sessionIds, "sessionIds"),
            ),
          };
      }
    }).pipe(Effect.mapError(mapFailure(input.operation))),
} satisfies Parameters<typeof AgentToolkit.toLayer>[0];

export const AgentToolkitHandlersLive = AgentToolkit.toLayer(handlers);

export const __testing = {
  isDescendantOf,
  ownedRecords,
  pathIsInside,
  sessionState,
  validateReviewWorkspace,
};
