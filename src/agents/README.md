# `agents/` — the untrusted side

Everything here reasons with a model. Nothing here may act.

## The rule, and it is structural

No module **reachable from** `agents/` may import `fs`, `child_process`, a git client, or
the network — not directly, and not through a dependency. That last part is the whole
point: `tests/architecture/dependencies.test.ts` walks the transitive import closure, so
`agents/ → llm/client → recording → node:fs` fails the build rather than passing a grep.

`SECURITY.md` states there is no code path from an agent to a file. This is that statement,
made checkable.

Two consequences that look odd until you know why:

- `llm/client.ts` holds **types only**. An agent imports it, so a runtime import there would
  put `ai` — and everything it reaches — inside the agent closure.
- `fileRecordingStore` lives in `cli/`, not `llm/`, for the same reason.

## What an agent receives

Plain data, handed in. Never a graph, never a provider, never a path.

- The Supervisor gets the request and a **bucketed** SI summary (`context/graph/summary.ts`),
  and no tools at all. It answers `MUTATION` or `QUESTION`, and a third answer is refused
  rather than defaulted — declare, never infer.
- Later agents get a tool registry built for them in `tools/`, whose functions close over an
  `EntityGraph` the agent itself never holds.

## Orchestration is not an agent's job

Plain TypeScript sequences the steps; no agent decides what runs next (design § 6,
ADR-0001). The harness renders nothing either — it emits `AgentEvent`s, Ink draws them at
stage 7, and the tests assert the same stream.

## The cost, stated plainly

Every capability an agent needs has to be handed to it from outside. Adding one is a change
in two places, and it will keep feeling like friction. That friction is the feature: it is
what makes "the agent drafts, the engine signs" true by construction rather than by review.
