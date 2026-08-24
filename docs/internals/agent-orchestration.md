# Agent orchestration internals

Provider-neutral orchestration is implemented as a scoped MCP capability over
the existing event-sourced thread runtime. It deliberately does not introduce a
second agent runtime or an invisible background-job model.

## Lifecycle

1. `ProviderService` reads the server-authoritative agent-orchestration setting
   when it starts a provider session.
2. The MCP session credential records an `agents` capability. Requests without
   that capability fail in the tool handler.
3. `agent_run start` validates the exact configured provider instance and model,
   then dispatches internal `thread.spawn` and ordinary `thread.turn.start`
   commands.
4. `thread.spawn` emits the existing `thread.created` event. Its
   `metadata.agentSpawn` field records the parent, stable spawn identifier,
   depth, delegation grant, creator session, and optional workflow role.
5. Existing projections, provider reactors, persistence, streaming, sidebar,
   cancellation, and archives handle the child as a normal thread.

No database migration is needed: the orchestration engine lazily hydrates an
in-memory ownership index from immutable event metadata on the first agent-tool
call and advances it with each commit. Ordinary engine startup never replays the
event history for this feature. Stable caller idempotency keys derive stable
command and thread identifiers, so a retry observes the original child and
cannot create a second one.

## Authorization and limits

Tool calls are authenticated with the existing provider-scoped bearer token.
Every control or inspection operation walks `agentSpawn.parentThreadId` links
and accepts only descendants of the invoking thread. Traversal detects cycles.
A restarted provider session in the same parent thread retains control of its
durable children; unrelated threads do not.

Children default to the parent's project, branch, and worktree and are forced
to `approval-required`. The tool schema exposes model choice and provider
options, but no arbitrary runtime-mode override. A child may explicitly request
the narrower `read-only` access policy. Only that policy accepts a custom
working directory, and only after the server canonicalizes it, verifies it is
beneath the operating-system temporary directory, and reads the fixed
`.t3code-review-snapshot` attestation marker. The child thread stores that
canonical path as its worktree with no branch.

Provider adapters enforce read-only mode independently: Codex uses a read-only,
networkless sandbox and removes MCP/web-search launch configuration; Claude
loads only Read, Grep, and Glob with `dontAsk` and no settings sources or T3 MCP;
OpenCode installs a deny-by-default permission ruleset; Cursor and Grok
automatically choose a provider-supplied rejection option for every ACP
permission request. All adapters omit the T3 MCP endpoint in read-only mode.

Current limits are depth 2, eight active descendants, 32 unarchived descendants,
and eight starts per call.

## Waiting without races

The engine exposes a scoped subscription to its domain-event PubSub. `wait`
subscribes before reading the initial projection, then returns on a relevant
state change or after at most 60 seconds. Tests and alternate engine layers may
omit the optional subscription and receive an immediate snapshot instead.
