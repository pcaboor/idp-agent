# `agents/` — the untrusted side

Everything here reasons with a model. Nothing here may act.

## The rule, and it is structural

No module **reachable from** `agents/` may import `fs`, `child_process`, a git client, or
the network — not directly, and not through a dependency. That last part is the whole
point: `tests/architecture/dependencies.test.ts` walks the transitive import closure, so
`agents/ → llm/client → recording → node:fs` fails the build rather than passing a grep.
Three of its thirteen rules cover this folder: *`agents/` does not import fs, git or
child_process*, *no module reachable from `agents/` touches the disk or the network*, and
*`agents/` imports `llm/client.js` and nothing else from `llm/`*.

`SECURITY.md` states there is no code path from an agent to a file. This is that statement,
made checkable.

Two consequences that look odd until you know why:

- `llm/client.ts` holds **types only**. An agent imports it, so a runtime import there would
  put `ai` — and everything it reaches — inside the agent closure.
- `fileRecordingStore` lives in `cli/`, not `llm/`, for the same reason.

## What lives here

| file | what it is |
|---|---|
| `supervisor.ts` | `MUTATION` or `QUESTION`, no tools, no third answer |
| `analyst.ts` | a question against the graph, terminating in `answer` |
| `inspector.ts` | an application repository read into `ProjectFacts`, terminating in `report_facts` |
| `architect.ts` | a draft into a typed buffer, terminating in `propose` |
| `reviewer.ts` | substance, not shape: `ok` or a reason, terminating in `verdict` |
| `repair.ts` | the five gates of design § 6.1 over a draft, three attempts, then a clean stop |
| `forced-turn.ts` | one bounded turn, the last forced onto the terminal tool |
| `summary.ts` | the bucketed SI summary an agent is shown |
| `events.ts` | `AgentEvent`, `EventSink` — the harness renders nothing |
| `tools/` | `graph-tools.ts` (SI reads), `project-tools.ts` (the snapshot), `propose-tool.ts` |

## What an agent receives

Plain data, handed in. Never a graph, never a provider, never a path.

- The **Supervisor** gets the request and a bucketed SI summary (`context/graph/summary.ts`),
  and no tools at all. It answers `MUTATION` or `QUESTION`, and a third answer is refused
  rather than defaulted — declare, never infer.
- The **Analyst** and the **Architect** get a tool registry built for them in `tools/`,
  whose functions close over an `EntityGraph` the agent itself never holds.
- The **Inspector** gets a `ProjectSnapshot` that `context/project-fs` has already read,
  capped and stripped: `.env*`, key material, credential files, `.git/`, `node_modules/`
  and hidden directories bar `.github` are gone before this folder sees anything.
  `list_files` and `read_file` read that snapshot and nothing else, so "confined to the
  repository" is a property of the data it was handed rather than a check it performs.
- The **Reviewer** gets the `Plan` and the **original request**, and nothing else. Not the
  Architect's transcript, not which attempt this is, not what an earlier gate said. It and
  the Architect are the same weights behind the same provider, so their errors are
  correlated by construction; a second opinion fed the first one's reasoning is an echo,
  and this echo holds a veto.

## What the Architect cannot express

`propose-tool.ts` builds its schema from the operation union **minus**
`create-catalog-info`, because that operation carries `repoPath` and a path field in front
of a model is a path a model chooses. The restriction is an absence in the tool spec, not
a sentence in a system prompt: a sentence is a request, and an absent field is not
something a model can decline to honour. `init` mints the real operation afterwards, from
the **signed** plan — see `cli/commands/init.ts` for why that order is load-bearing.

## Orchestration is not an agent's job

Plain TypeScript sequences the steps; no agent decides what runs next (design § 6,
ADR-0001). `repair.ts` runs the five gates in a fixed order — `zod`, `signature`, `policy`,
`reviewer`, `recheck` — with the three free ones first, so a draft that cannot survive them
never reaches the one that spends a model call. The harness renders nothing either: it
emits `AgentEvent`s, `cli/index.ts` writes one line per event to stderr, Ink draws them at
stage 7, and the tests assert the same stream.

## The cost, stated plainly

Every capability an agent needs has to be handed to it from outside. Adding one is a change
in two places, and it will keep feeling like friction. That friction is the feature: it is
what makes "the agent drafts, the engine signs" true by construction rather than by review.

**And what none of it covers.** Nothing in this folder can be trusted to be *right*. A
bounded loop, a typed buffer and a closed union say what an agent may express, never
whether what it expressed is correct — that is what the gates in `core/plan/` are for,
what the diff is for after them, and what the merge is for after that.
