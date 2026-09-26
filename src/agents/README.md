# `agents/` — the untrusted side

Everything here reasons with a model. Nothing here may act.

## The rule, and it is structural

No module **reachable from** `agents/` may import `fs`, `child_process`, a git client, or
the network — not directly, and not through a dependency. That last part is the whole
point: `tests/architecture/dependencies.test.ts` walks the transitive import closure, so
`agents/ → llm/client → recording → node:fs` fails the build rather than passing a grep.
Four of its fourteen rules cover this folder: *`agents/` does not import fs, git or
child_process*, *no module reachable from `agents/` touches the disk or the network*,
*`agents/` imports `llm/client.js` and nothing else from `llm/`*, and *trace/ reaches nothing
but types, and only cli/ reaches it* — so no agent imports `trace/`. A trace is one more
reader of the events an agent emits (ADR-0009); an agent does not know it is traced.

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
| `analyst.ts` | a question against the graph, terminating in `answer`: `entities`, `nothing`, `overview` (chosen, never written — the engine describes the catalogue) or `unanswerable`; the first three may carry the model's `intro` and `conclusion` |
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
  whose functions close over an `EntityGraph` the agent itself never holds. A refused
  call comes back as an error the model reads and the `tool:result` event carries, so
  the terminal prints the reason rather than `0 row(s)`.

  The Analyst's `search_entities` also refuses a `kind`, `type`, `env` or `owner` **no
  entity carries**, naming the values in use: a real model fills every optional
  criterion it is shown, and an invented `env: "default"` read as a search that ran and
  found nothing. `nameContains` stays a plain filter. The Architect's registry is built
  with `refuseUnusedValues: false` and still answers those with an empty result, for
  now: four of its five plan-mode tapes searched on such a value, and a tool result is
  part of every later request's digest. Whether to turn the refusal on for it is an open
  decision, not a consequence of re-recording — the Architect reads an empty result as a
  finding (`type: database-access` finding no grant is how it learns one must be
  proposed), and an error there changes what it is told on a normal path. Until that is
  decided, `plan` and `init` share the same opt-out.
- The Analyst's registry is built with `apis: true` (`cli/commands/ask.ts`): Backstage's
  APIs are part of the read model (design §4.1), so its search takes `kind: "API"`
  (`apiSearchCriteriaSchema`), a fifth tool, `get_apis`, reads `provides` (the APIs a
  component declares in `spec.providesApis`) or `providedBy` (the components that declare
  an API), and a row says what its entity declares about APIs — what `show`'s card prints
  of an API: its lifecycle, that its definition is `declared` (never its text), its
  description, system, tags and links, and its providers; a component's `provides`, only
  when it provides one. A tool of its own rather than a
  direction of `get_dependencies`, because providing is not depending, and who *consumes*
  an API is a right over it, which `get_dependencies` `consumers` already walks. Every
  reference a row names joins the witness set.

  A reference the catalogue declares and no entity answers to is read too, never as an
  entity: a row carries its entity's under `danglingReferences`, and `get_dependencies`
  and `get_apis` put the ones on the side asked about beside `rows`, under the same key —
  the subject's own `dependsOn`, `dependencyOf` or `providesApis`, and for `consumers` the
  services every right on the walk names. Each is `{ ref, declared: false, field,
  declaredBy, sameName }`: `rows` stay a list of entities, each witnessed, and the flag
  says what the object is wherever it is quoted. A list is cut at the rows' bound, and the
  cut stated beside it (`danglingTruncated`) as `truncated` states the rows'. `declaredBy`
  and `sameName` are entities the engine returned, so they join the witness set; the
  reference itself never does, and an `entities` answer naming it is refused as any
  invention is. What a result showed is kept apart (`declaredNowhere`): the commentary
  check lets a sentence quote such a reference as a value its declarer declares, and only
  once shown — a declarer witnessed as a provider or as another reference's `declaredBy`
  had none of its own read, and a reference quoted by its bare name names its homonym.
  A turn whose results held only such references read something, and is not barren
  (`ToolOutcome.dangling`), though the stream still counts its rows, none. The Analyst's
  system prompt says, in one sentence, to say so and never to take it for the entity of
  its name. The Architect's registry has none of it:
  it proposes neither an API nor what provides one, and its specs — part of every
  plan-mode recording's digest — are held byte for byte to the ones they were
  (`tests/golden/architect-tools.json`), as is every row of an entity that declares
  nothing about an API.
- The Analyst's `answer` **discards** any field its outcome does not declare — the flat
  advertisement shows `refs` and `reason` beside every outcome, and a real model fills
  them — and never reads it (ADR-0007, amended). When every answer it sent was refused,
  the refusal says so and names the issue, rather than that nothing matched.
- `entities`, `nothing` and `overview` also carry an optional `intro` and `conclusion`,
  the model's words around the block the engine prints, written in the same call
  (ADR-0008). A malformed or oversized one is dropped at the parse, never refused and never
  worth a repair turn. The Analyst hands them back **unchecked**: the check needs every
  entity the graph holds, and an agent never holds a graph, so `cli/commands/ask.ts` runs
  `core/answer/commentary.ts` before a word is printed. They never reach the event stream —
  `answer:ready` is the outcome and the references, and nothing else.
- The **Inspector** gets a `ProjectSnapshot` that `context/project-fs` has already read,
  capped and stripped: `.env*`, key material, credential files, `.git/`, `node_modules/`
  and hidden directories bar `.github` are gone before this folder sees anything.
  `list_files` and `read_file` read that snapshot and nothing else, so "confined to the
  repository" is a property of the data it was handed rather than a check it performs.
  It runs only when there is an application repository to read; otherwise the Architect
  is handed `NOT_INSPECTED` instead of `ProjectFacts`, and its opening message says that
  nothing was inspected rather than listing facts nobody established.
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
