# Agent orchestration

T3 Code can let the agent in one thread start and monitor other configured
providers as child threads. The children are ordinary T3 Code threads: they
appear in the sidebar, stream their work normally, survive application
restarts, and can be opened at any time.

This feature is disabled by default. Enable **Settings → Integrations → Agent
orchestration** before starting the parent provider session. Changing the
setting affects new provider sessions; restart an existing session so it
receives the updated tools.

The parent agent receives two tools:

- `agent_manage` lists exact provider instances and model slugs, shows owned
  child sessions, reads their transcripts, and archives selected finished
  children.
- `agent_run` starts up to eight children in one batch, polls or waits for
  progress, sends a follow-up after a turn finishes, and cancels running turns.

Model options are passed through the existing model selection, so a workflow
can request a configured reasoning effort when the provider supports it.

## Safety boundaries

Starting child agents can consume paid provider tokens. T3 therefore requires
an explicit opt-in and limits a parent to eight active and 32 unarchived
descendants. Archiving finished sessions frees retained capacity. Delegation is
off for children unless the caller explicitly enables it, and the maximum
delegation depth is two.

Children inherit the parent thread's project, branch, and worktree. They always
start in **approval required** permission mode; the parent cannot use these
tools to grant a child broader filesystem or command authority. Ownership is
scoped to the parent thread, so one thread cannot inspect or control another
thread's children.
