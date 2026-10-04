# The Inspector's facts, held to the files it read

**Status: Task 1 built ([#141](https://github.com/pcaboor/idp-agent/pull/141)), waiting for the
owner's re-record of `link-already-declared` (Step 8); see [As built](#as-built).** One pull
request, `fix/inspector-witness`, after this plan merged on its own
(`docs/plan-inspector-witness`). It is the first half of the queue's item 1, "Two fixes before
stage 8" (owner's decision, 2026-10-03); the second half, `idpa protection`'s reason for a
ruleset that supplies none of the three rules, is built
([#139](https://github.com/pcaboor/idp-agent/pull/139)). The owner answered the five questions
[at the end](#questions-for-the-owner) on 2026-10-03, each as recommended.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal.** The engine keeps a fact the Inspector reports only where a file the Inspector really
read states it, as it already keeps an `Answer` to the references a tool returned (ADR-0007) and
the model's sentences around it to what was read (ADR-0008). A fact no such file states is
withdrawn: it becomes `{ unknown: <the engine's reason> }`, it is said on stderr and in the
trace, never dropped in silence, and where it matters it becomes a question. One check, in the
Inspector's loop, so both roads get it: `plan "<intent>"` (and a phrase's change), where the
facts reach the Architect's opening message, and `init`, where they also reach the signature as
the answers `inspected()` places.

**What it does not hold: the reason a model gives for its own unknown.** The check is over the
**values** a report states. A field the model marks `{ unknown: <why> }` keeps the model's own
`<why>`, up to `PLAN_LIMITS.maxStringLength` (8,192) characters (`src/core/schemas/plan.ts:43-45`),
and `formatFacts` prints it as `unknown (<why>)` in the Architect's opening
(`src/agents/architect.ts:73-74`). So `runtime: { unknown: "a Node.js fastify service using
postgresql and redis, named gorilla-service" }` still reaches the Architect, past every rule
below. This pull request leaves that channel open, says so wherever it states the guarantee, and
pins it with a test (Step 2, test 7), because closing it changes the bytes of all five Inspector
tapes (question 5). The other model-written reason, the one an inspection with **no** report
ends on, is closed here: today `undetermined()` puts `said.slice(0, 400)`, the model's prose,
into all seven unknowns (`src/agents/inspector.ts:261-266`). It becomes the engine's fixed
reason, and the model's words stay on the `refused` event, for a person. No tape ends with no
report, so that costs no tape.

**Why.** On 2026-10-02 the `link-ambiguous-env` tape's Inspector (OpenAI `gpt-6-luna`) passed a
`package.json` it wrote itself as `read_file`'s `content` (`@thronecode/gorilla-service`, with
fastify, redis, jsonwebtoken and bcrypt) with no `path`. The call was refused. It then reported
`gorilla-service`, Node.js, PostgreSQL and Redis. The engine accepted the report, and the
Architect was sent those values as facts, where the scenario's `package.json` is `billing-api`'s
with `pg` alone. The owner recorded that tape again on 2026-10-03. The guard that caught it
reads the tapes only (`plan-mode.test.ts`, *holds an Inspector that reports what a file it read
says*). Nothing checks a live run. Review ids **security-5** ("witness each Inspector fact
textually, or it is asked") and **gap-init-real-repos-5** ("place an Inspector fact only when
its value occurs in a file it read; otherwise ask") name the same gap for `init`.
[`docs/roadmap.md`](../roadmap.md) names it for the plan road too, under *What the Inspector
reports is not held to the files it read, on the plan road too*.

**Closed by** this one pull request, and by the owner's re-record of `link-already-declared` on
its branch before it merges (see [the measurement](#the-measurement-on-the-twelve-tapes) and
question 1). A scripted client that reproduces the 2026-10-02 invention, with no tape, ends with
no invented value in the Architect's opening message on `plan`, and with a question rather than
a diff on `init`.

**Every file and line named below was read on `main` at `ded3ff2`.**

---

## Global Constraints

Inherited and binding: `AGENTS.md`, `docs/design.md` §4. A step that cannot keep one is stopped
and brought to the owner.

- **Byte-neutral for what an honest Inspector reports.** The Inspector's system prompt, its
  opening message, its three tool specs and `projectFactsSchema` do not change. A model is told
  nothing new and sent nothing new. `formatFacts` (`src/agents/architect.ts:87-115`) does not
  change either. The Architect's opening message moves only when a fact is withdrawn, and then
  only at the withdrawn line. `tests/unit/architect.test.ts`'s *sends the facts in exactly the
  bytes the plan-mode recordings were made with* stays green unchanged.
- **Post hoc, never a retry.** The check runs on the report the loop accepted. It is not handed
  back to the Inspector as an error. A retry would add a model turn to every run where a fact is
  withdrawn, would teach a model to find a word it can quote, and would stale every tape where it
  fires (question 2).
- **Never ignore in silence.** A withdrawn fact is an `unknown` with the engine's reason, an
  `unwitnessed` event, a stderr line and a trace note. The reason the Architect is sent never
  quotes the withdrawn value. Quoting it would put the invention back in front of the model that
  is drafting. The value goes to stderr and the trace, for a person.
- **The guarantee is stated no wider than it is.** Every sentence this pull request adds to
  `AGENTS.md`, `docs/design.md`, `SECURITY.md` and `src/agents/README.md` says "a value the
  Inspector reports", and names the reason a model writes for its own unknown as the channel
  left open until question 5 is answered. A row that says "what the Inspector reports reaches a
  model only where a file states it" would be read as covering the reasons, and it does not.
- **No language is privileged.** "States" is `echoes` (`src/core/plan/echoes.ts:67`), the one
  whole-token test the signature already applies to a request: NFKC, case-folded, invisible
  characters removed, and a change of script ends a token. The keyed rule's keys are field
  names of file formats, never words of a language: `lifecycle` and `type` are Backstage's,
  and `name`, `module` and `artifactId` are those a manifest names its package by
  (`package.json`, `Cargo.toml`, `pyproject.toml` and a catalog-info; `go.mod`; `pom.xml`). A
  file that says it in prose, in any language, is not a witness, so the value is asked. That is
  the safe direction.
- **`pnpm test` needs no key, no network and no Docker.** No tape is edited by hand. The one tape
  that goes stale is re-recorded by the owner, with the owner's key.
- **Traceability.** The pull request adds its line under `## Unreleased` in `CHANGELOG.md`
  (Fixed). It updates `docs/roadmap.md`: queue item 1 becomes half done, and the Behaviour debt
  and the `init` line under *Left from the sweep of the review* are closed. It updates the
  review's [Status](../reviews/2026-09-23-deep-review.md#status) with security-5 and
  gap-init-real-repos-5. In the same commit it re-measures the test count that `AGENTS.md` and the
  README's badge state.
- **The pull request is green at its end** (`pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm smoke`), with one exception: `link-already-declared`, which stays red until it is
  re-recorded. Steps 2 and 3 are red on purpose, each test for its stated reason.
  `df -h /` comes before any full run, and the run stops under 1 GiB free.
- **Standing rules.** No commit, push or pull request without the owner's go-ahead. Stage files
  by name. English throughout, Conventional Commits, and no `switch` on a closed union without
  `const exhaustive: never = value` in `default`.

---

## What "a file states it" means, per field

**A file the Inspector really read** is one whose text `read_file` returned to the model in a
turn **before** the turn that carries the accepted `report_facts`. The following are never a
witness:

- a path `list_files` returned (a folder called `billing-api/` is a name nobody chose);
- the opening message's list of excluded paths and their reasons;
- a refused `read_file` (an excluded file, a near miss, a call with no `path`);
- the model's own arguments (the 2026-10-02 `content`);
- a file read in the same turn as the report, which the model had not seen when it wrote the
  report;
- `snapshot.root`;
- the catalog-info files `init` reads whole outside the budget (`ProjectRead.declarations`),
  unless the model also read them with `read_file`.

"States" is checked with three rules and one refusal. Each rule is a predicate over the texts of
those files.

| Rule | A file states `value` when | Built on |
|---|---|---|
| **token** | some file holds `value` as a whole token | `echoes(text, value)` |
| **keyed** | some **line** of a file holds one of the field's keys and `value`, each as a whole token | `keys.some((key) => echoes(line, key)) && echoes(line, value)` |
| **reference** | some file holds the reference in full, `kind:namespace/name`, or as `kind:name` when the namespace is `default`, as a whole token | `echoes` on either spelling, as `requestedEnvironment` reads a reference |
| **never** | no file can state it; the value is always withdrawn | none |

| Field (`projectFactsSchema`, `project-tools.ts:69-97`) | Rule | Why this rule |
|---|---|---|
| `name` | **keyed**, keys `name`, `module`, `artifactId` | The one fact `init` places silently: `inspected()` signs it as an answer (`init.ts:313-326`), so it is never asked. A whole token anywhere would let any word of any file read vouch for it: over the tapes' `package.json`, `pg` and `dependencies` are both whole tokens. Keyed, `"name": "billing-api"`, `"name": "@acme/billing-api"`, `name = "billing-api"`, `module github.com/acme/billing-api` and `<artifactId>billing-api</artifactId>` state it; `"pg": "^8.11.0"`, `# billing-api` in a README and `container_name: billing-api` do not. `billing` is not stated by `billing-api`, because the hyphen joins the token. Known limit: any `name` line states its value, so a workflow's `name: ci` or a Kubernetes manifest's `name: billing-db` witnesses `ci` or `billing-db` (test 4 pins it). A tighter "byte-equal to a manifest's name" is stage 8's (brief § 5, 2.6), with its extractors. |
| `type` (a Component's) | **keyed**, key `type` | The values are ordinary words ("service", "library"). "This service…" in a README is no statement. `type: service` in a catalog-info is one. Known limit: `"type": "module"` in a `package.json` would witness `module` (a test pins it). |
| `lifecycle` | **keyed**, key `lifecycle` | The one field whose plausible default, `production`, is the dangerous one (`project-tools.ts:44-45`). `NODE_ENV=production` holds `production` as a token and says nothing about a lifecycle. `lifecycle: production` says it. Known limits, both pinned by test 4: `LIFECYCLE=production`, an environment variable, holds the key as a whole token and is a witness; and a file of **one line** (a minified `package.json`, one-line JSON or YAML) makes the keyed rule a whole-file test, so `{"scripts":{"lifecycle":"run"},"config":{"env":"production"}}` witnesses `production`. The same two hold for every keyed field. A tighter "the value is the key's own value" needs a parser per format, which is stage 8's extractors. |
| `runtime` | **token** | `"engines": { "node": ">=22" }` states `node`. `Node.js`, a model's normalisation, is stated by no file there, so it is withdrawn. The field reaches only the Architect's opening, never the signature (`init.ts:240-241`). |
| `owner` | **reference** | An owner is who authorises. A bare `owner: platform` would have to be turned into a reference by Backstage's defaults, and that is an inference, so it is no witness. The Inspector's own prompt already demands the reference in full (`inspector.ts:42-47`). |
| `forgeHandle` | **token** | Reported verbatim from CODEOWNERS (`* @acme/platform`). It is never an owner, and that stays as it is. Known limit: `echoes` checks the left edge only when the value begins with a letter or a digit (`echoes.ts:157`), so `@acme.com` is stated by `bob@acme.com` and `@acme/platform` by `x@acme/platform` (test 4 pins it). Harmless, because the field reaches only the Architect's opening and never `spec.owner`. |
| `dependencies[].name` | **token** | `"pg": "^8.11.0"` states `pg`. If **any** name is not stated, the **whole list** becomes unknown, with the count in the reason (question 3). A list that has lost an entry reads as a complete list, and the Architect would fill the gap (`architect.ts:83-85`, "an unknown is printed, never dropped"). |
| `dependencies[].type` | **never** | A type is a classification, not a statement. The schema says so itself: "`redis` in a dependency list says a library is installed, not what it is reached for here" (`project-tools.ts:29-30`). Even a line that reads `pg: database` would be someone's classification. Stage 8 removes the field (brief, slice 2, item 2). |

When the list is withdrawn whole, one event is emitted per unstated name, **and one for the field
`dependencies` itself**, whose value is every reported name, in order and comma-separated, and
whose reason is the list's. So with `[pg (stated), redis (invented)]` stderr says both
`dependencies.1.name is unknown, not redis` and `dependencies is unknown, not pg, redis`, and a
person sees that `pg` was taken off the Architect's facts too. The entries' types are not
reported a second time. When the list is kept, one event is emitted per type it withdraws.

The reasons the engine writes into an `unknown` are fixed strings, so the request bytes are
deterministic. They name the field and never the value:

- a scalar: `no file the Inspector read states the <name | type | lifecycle | runtime | owner | forge handle> it reported`;
- the list: `no file the Inspector read names <n> of the <m> dependencies it reported`;
- a dependency's type: `a dependency's type is never read off a file: a package in a manifest says what is installed, not what it is reached for`;
- every field, when the inspection ended with no report: `the inspection ended with no report, so nothing about this repository was established`, the string `inspector.ts:263` already writes when the model said nothing. The model's words go on the `refused` event alone.

**Where it matters, it becomes a question.**

- **On `init`,** `requestOf` (`init.ts:250`) and `inspected()` (`init.ts:313-326`) already place
  only string facts. A withdrawn name, type, lifecycle or owner therefore vouches for nothing.
  The Architect's value for that field signs `novel`, and it is asked at a terminal. With nobody
  to ask, the run exits 3, and `renderInitQuestions` names the flags that answer the fields
  that have one (`--name`, `--lifecycle`, `--owner`: `INIT_FLAGS`, `init.ts:345-349`) and says
  of `spec.type`, which has none, `… has no flag: run this at a terminal to be asked.`
  (`init.ts:763-768`). `init.ts` needs no new code, only its comments.
- **On the plan road,** the facts are the Architect's context only. What it then drafts is signed
  against the request, the answers and the catalogue (`plan.ts:1620`), as it is today.

---

## The measurement on the twelve tapes

**Method.** The tapes were replayed in a scratch harness outside the repository, with no model.
For each tape, the harness collected the texts of every `read_file` result in the Inspector's
last request and the accepted `report_facts` input. It applied each rule above using the real
`echoes`. A throwaway prototype of the check was then run, in a copy outside the worktree,
against `tests/scenarios/plan-mode.test.ts`, `prompt-digests.test.ts` and the unit and contract
files that script an Inspector. Both the harness and the copy are deleted. The figures below come
from those runs. After the review of this plan, the `name`, `lifecycle` and `forgeHandle` rows
were measured again the same way, with the real `echoes` over the five tapes' `read_file` texts
and over the limit cases each row names; that harness is deleted too.

**Seven tapes have no Inspector turn**: `mutation-classified-link` and the six `question-*`
tapes. They are unaffected by construction.

**Five tapes have one**, each reading `package.json` (`{"name": "billing-api", "dependencies":
{"pg": "^8.11.0"}}`, on six lines, so `"name": "billing-api"` is a line of its own) and
reporting:

| Tape | name | type, lifecycle, runtime, owner, forge handle | dependencies | Architect's opening |
|---|---|---|---|---|
| `link-ambiguous-env` | `billing-api`, kept (keyed, and token) | all unknown, unchanged | `pg`, kept; type unknown | **unchanged** |
| `link-db-exists` | `billing-api`, kept | all unknown | `pg`, kept; type unknown | **unchanged** |
| `link-db-missing` | `billing-api`, kept | all unknown | `pg`, kept; type unknown | **unchanged** |
| `repair-malformed-owner` | `billing-api`, kept | all unknown | `pg`, kept; type unknown | **unchanged** |
| `link-already-declared` | `billing-api`, kept | all unknown | `pg`, kept; **type `database`, withdrawn** | **changes**: `    pg: database` becomes `    pg: unknown (a dependency's type is never read off a file: …)` |

**One tape goes stale, `link-already-declared`, and no rule that holds the invariant avoids
it.** `database` is withdrawn under all three candidates measured for a dependency's type:
*never*; *token*, because `database` is in no file read; and *keyed* on the dependency's own
line, because `"pg": "^8.11.0"` does not hold `database`. The Inspector inferred `database` from
`pg`, which is the inference its own schema forbids. The prototype replay confirms it: of the
ten plan-mode tests, only *link-already-declared: the access is in the repository already*
fails, with "prompt changed since recording". Its four Architect turns carry the opening message
and its Reviewer turn does not. `prompt-digests.test.ts` stays green. The re-record needs the
owner's key (question 1). The Inspector's own requests do not move, so a re-recorded Inspector
may report `database` again. That is harmless: the Architect is sent `unknown` either way.

**The reasons a model writes for its own unknowns** are in every one of the five tapes: the
Architect's opening carries five such lines in `link-already-declared` (type, lifecycle,
runtime, owner, forge handle) and six in the four others (the same and `pg`'s type), for
example `type: unknown (package.json gives the package name but does not state the application
type.)`. Replacing them with the engine's fixed reasons (question 5) would change the Architect's
opening of all five, and stale all five tapes. Leaving them, as this plan does, changes none. The
no-report reason changes no tape: every Inspector turn in the twelve ends on an accepted report.

**The reconstructed 2026-10-02 report** withdraws everything it stated: `gorilla-service`,
`service`, `production`, `Node.js`, and the list `postgresql` and `redis`. It withdraws them with
no file read and also with `billing-api`'s `package.json` read. The pre-2026-10-02 version of
`link-ambiguous-env` (`a680e65^`) reported `pg: database-access` and would have been withdrawn
the same way.

**Existing tests whose scripted Inspector reports what no file it read states.** The prototype
counted 62, and they are what makes this one pull request rather than a one-line change. The
keyed `name` rule leaves the count where it was: outside `plan-mode.test.ts`, only
`inspector.test.ts`, `trace-builder.test.ts` and `project-tracked.test.ts` script a
`read_file` at all, and none of them asserts a name a file holds as a bare token; every failing
test below reads nothing before its report, or reads only `{}`, so it fails under any rule.

| File | Failing | Why | Fix |
|---|---|---|---|
| `tests/unit/init-command.test.ts` | 29 | `drafting` (`:370-374`) reports `FACTS` (`:351-359`) with no `read_file`, and `application()` (`:340-349`) holds no file stating type, lifecycle, owner or runtime | `application()` gains a `README.md` keying each fact; `drafting` reads every file before it reports |
| `tests/unit/init-real-repo.test.ts` | 18 | its `drafting` (`:244-248`), the same | the same |
| `tests/contract/key-reach.test.ts` | 9 | the three providers' `init --submit` legs: the wire answers `report_facts` as soon as it is offered (`:258`), with `FACTS` (`:226`) | the wire calls `read_file` first, on a fixture that states `FACTS` |
| `tests/unit/inspector.test.ts` | 4 | *refuses a report that omits a field*, *returns the facts the model signed off*, *puts a malformed report back*, *degrades to an open tool choice*: each reports over `EMPTY`, or reads nothing | each reads a file that states what it reports |
| `tests/unit/trace-wiring.test.ts` | 1 | *is the text without a terminal's escape sequences…*: an `init` run that now asks (exit 3) | its Inspector reads what it reports |
| `tests/scenarios/plan-mode.test.ts` | 1 | `link-already-declared`, stale | the owner's re-record |

The fix is the fixture, never the rule: each one is made to read a file that states what it
reports. `plan-intent.test.ts`, `plan-ask.test.ts`, `plan-project.test.ts`, `entry.test.ts` and
`backstage-source.test.ts` stay green. Their facts reach only a scripted Architect.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/agents/tools/project-tools.ts` *(edit)* | `read()`: the files `read_file` returned, in order, each once (the success branch at `:215`). The comment *What this does NOT give the Architect* (`:64-67`) says what the witness now gives and what it does not. |
| `src/agents/tools/project-witness.ts` *(new)* | `WITNESS_RULES`, `WITNESS_KEYS`, `witnessFacts`, the reasons. Pure: imports `core/plan/echoes.js` and the schema's type, nothing else. |
| `src/agents/inspector.ts` *(edit)* | It counts the reads at the start of each turn, witnesses the accepted report (`:216-219`) against the reads before that turn, and emits one `unwitnessed` event per withdrawn value, and one for a list withdrawn whole. `undetermined()` (`:97-105`, `:261-266`) is handed the engine's fixed reason; the `refused` event keeps the model's words. |
| `src/agents/events.ts` *(edit)* | `{ type: 'unwitnessed'; agent: 'inspector'; field: string; value: string; reason: string }` |
| `src/cli/index.ts` *(edit)* | `renderEvent` (`:1145`): `  = <field> is unknown, not <value>: <reason>`, with the value through `said` |
| `src/trace/builder.ts` *(edit)* | `note('unwitnessed', { field, value, reason })` on the Inspector's span, beside `reapplied` (`:354`) |
| `src/cli/commands/init.ts` *(edit, comments only)* | `requestOf` (`:206-246`) and `inspected()` (`:302-312`): a fact is placed only where a file the Inspector read states it |
| `src/agents/README.md` *(edit)* | The Inspector's row, and the witness beside the Analyst's |
| tests, below | test first |
| `AGENTS.md`, `docs/design.md`, `SECURITY.md`, `docs/stage-8-brief.md`, `docs/roadmap.md`, the review's Status, `CHANGELOG.md`, `README.md` (badge) | [the docs it makes true](#the-docs-it-makes-true) |

No architecture rule moves: `agents/` already imports `core/`, and the check reads only texts
already in memory. The count stays at the number `pnpm vitest run tests/architecture
--reporter=verbose` reports.

**Interfaces.**

```typescript
// src/agents/tools/project-tools.ts
export interface ReadFile { readonly path: string; readonly text: string }
export function buildProjectTools(snapshot: ProjectSnapshot): {
  specs: ModelToolSpec[]
  run(call: ModelToolCall): ToolOutcome
  /** The files read_file returned, in the order first returned, each once. Never a path list_files gave. */
  read(): readonly ReadFile[]
}

// src/agents/tools/project-witness.ts
export type WitnessRule = 'token' | 'keyed' | 'reference' | 'never'
/**
 * One rule per field the report carries, and one per field of a dependency: a field added to
 * the schema without one is a compile error.
 */
export const WITNESS_RULES: {
  readonly [K in Exclude<keyof ProjectFacts, 'dependencies'>]: WitnessRule
} & { readonly dependencies: { readonly name: WitnessRule; readonly type: WitnessRule } }
// { name: 'keyed', type: 'keyed', lifecycle: 'keyed', runtime: 'token', owner: 'reference',
//   forgeHandle: 'token', dependencies: { name: 'token', type: 'never' } }
/** The keys of each keyed field: field names of file formats, never words of a language. */
export const WITNESS_KEYS: { readonly name: readonly string[]; readonly type: readonly string[]; readonly lifecycle: readonly string[] }
// { name: ['name', 'module', 'artifactId'], type: ['type'], lifecycle: ['lifecycle'] }
/** `field` as a path into the report: `name`, `dependencies`, `dependencies.1.name`, `dependencies.0.type`. */
export interface Unwitnessed { readonly field: string; readonly value: string; readonly reason: string }
export function witnessFacts(
  facts: ProjectFacts,
  read: readonly ReadFile[],
): { readonly facts: ProjectFacts; readonly unwitnessed: readonly Unwitnessed[] }
```

---

### Task 1: The Inspector's report, held to what it read

**Files:** as in the File Structure.

- [x] **Step 1: Pin the before (passes now).** `df -h /`, then `pnpm vitest run
  tests/unit/inspector.test.ts tests/unit/architect.test.ts tests/scenarios/plan-mode.test.ts
  tests/scenarios/prompt-digests.test.ts`: green. Note the test count of `pnpm test` for the
  `AGENTS.md` figure.

- [x] **Step 2: Write the Inspector's tests, and see each fail for its stated reason.** In
  `tests/unit/inspector.test.ts`, a new `describe('what a file it read states')`:
  1. *withdraws the 2026-10-02 invention: a package.json passed as content is read by nobody.*
     The snapshot is `billing-api`'s `package.json` with `pg`. Turn 0 is `read_file` with
     `{ content: '{"name":"@thronecode/gorilla-service","dependencies":{"fastify":"^4","redis":"^4","jsonwebtoken":"^9","bcrypt":"^5"}}' }`
     and no `path`. Turn 1 is `report_facts` with `name: 'gorilla-service'`, `type: 'service'`,
     `lifecycle: 'production'`, `runtime: 'Node.js'`, owner and forge handle unknown, and
     `dependencies: [{ name: 'postgresql', type: 'database' }, { name: 'redis', type: 'cache' }]`.
     The test expects each of those values to be unknown with the reasons above, no
     `gorilla`/`thronecode`/`Node.js`/`redis`/`postgresql` anywhere in `JSON.stringify(facts)`,
     and seven `unwitnessed` events: four scalars, two dependency names, and `dependencies`
     itself with the value `postgresql, redis`. *Fails today:* `facts.name` is
     `'gorilla-service'`.
  2. *keeps what package.json states, and changes nothing else*: the four unchanged tapes'
     shape. It reads `package.json`, reports `billing-api` and `pg` with an unknown type, and
     expects the facts deep-equal to the report and no `unwitnessed` event. *Passes today*, and
     is kept as the byte-neutrality pin.
  3. *does not count a file read in the turn that reports*: `read_file` and `report_facts` in one
     turn, so the name is withdrawn. *Fails today.*
  4. *states a value by the field's rule*, a table run through `inspect` (`it.each`): each row
     a snapshot, a turn that reads its file, and a turn that reports the value, so the row
     exercises the real read-before-report path. A name is kept from `"name": "billing-api"`,
     from `"name": "@acme/billing-api"`, from `module github.com/acme/billing-api` and from
     `<artifactId>billing-api</artifactId>`. It is not kept from `billing-api` inside a
     `list_files` path, an excluded file's reason, a README's `# billing-api` or
     `container_name: billing-api`, and `billing` is not kept from `"name": "billing-api"`; nor is
     a dependency's name, `pg`, kept as a name from `"pg": "^8.11.0"`. `lifecycle` is not stated
     by `NODE_ENV=production`, and is stated by `lifecycle: production`. `type: service` is kept,
     and `service` in prose is not. An owner `group:default/tiger` is kept from
     `group:default/tiger` and from `group:tiger`, and not from `owner: tiger` or from
     `group:other/tiger`. `@acme/platform` is kept from CODEOWNERS. A runtime `node` is kept from
     `engines`, and `Node.js` is not. A dependency's type is withdrawn even beside `pg: database`.
     *Each withdrawal fails today, because the value is kept; each keep passes today.* Four rows
     pin the documented limits, kept and passing today, so that tightening a rule is a visible
     change of this table: `"type": "module"` keeps the type `module`; `name: ci` keeps the name
     `ci`; `LIFECYCLE=production`, and the one-line
     `{"scripts":{"lifecycle":"run"},"config":{"env":"production"}}`, keep the lifecycle
     `production`; `bob@acme.com` keeps the forge handle `@acme.com`.
  5. *prints a withdrawn value as one cleaned line*: `renderEvent` of test 1's name event is
     exactly
     `  = name is unknown, not gorilla-service: no file the Inspector read states the name it reported`,
     and a value holding an ESC or a U+202E prints it spelled out, on one line. *Fails today:*
     `renderEvent` has no case for the event and hands it back through its `default`
     (`src/cli/index.ts:1217-1221`), an object where the test expects that line.
  6. *does not hand the Architect what the model said when no report came*: every turn a prose
     answer, `billing-api is a fastify service using redis`, and no tool call, so the barren bound
     ends the inspection on a forced last turn that answers in prose too (`said`,
     `inspector.ts:177-180`). Every field of the facts is
     `{ unknown: 'the inspection ended with no report, so nothing about this repository was established' }`,
     `fastify` is nowhere in `JSON.stringify(facts)`, and the `refused` event's reason still holds
     it. *Fails today:* every field's reason is `the inspection ended with no report: billing-api
     is a fastify service using redis`.
  7. *passes a model's own unknown reason through as written: the channel question 5 decides*.
     It reads `package.json` and reports `runtime: { unknown: 'a Node.js fastify service using
     postgresql and redis, named gorilla-service' }`, the other fields as test 2, and expects
     `facts.runtime` to be exactly that and no `unwitnessed` event. *Passes today*, and is kept as the pin of a stated limit:
     closing the channel is a visible change of this test, never a silent one.

  In a new file, `tests/unit/project-witness.test.ts`, so that its import cannot fail the
  Inspector's file:
  8. *has a rule for every field the report carries*: the keys of `WITNESS_RULES` equal those of
     `projectFactsSchema.shape`, its `dependencies` keys those of a dependency, and the fields
     whose rule is `keyed` are exactly those of `WITNESS_KEYS`. *Fails today:* the module
     `src/agents/tools/project-witness.ts` does not exist, and the file fails at its import.

- [x] **Step 3: Write the two roads' tests, end to end, with a scripted client and no tape, and
  see each fail.**
  - `tests/unit/plan-intent.test.ts`, *tells the Architect nothing the 2026-10-02 Inspector
    invented*. Run Step 2's scripted Inspector through `runIntent`. The Architect's opening holds
    `  name: unknown (no file the Inspector read states the name it reported)` and none of the
    invented strings. Its events render, through `renderEvent`, as the seven `  = … is unknown`
    lines. The exit code is the one the same run gives with an honest Inspector. *Fails today:* the opening holds
    `  name: gorilla-service`.
  - `tests/unit/init-command.test.ts`, *asks for a name the Inspector invented, rather than
    writing it*. The same Inspector, and an Architect that proposes `gorilla-service` with the
    invented type and lifecycle. With nobody to ask, the run asks at `metadata.name`,
    `spec.type` and `spec.lifecycle` and exits 3. Its text names `--name, --lifecycle` as the
    flags that answer two of them, says `operations.0.entity.spec.type has no flag: run this at a
    terminal to be asked.` of the third (`INIT_FLAGS` holds no flag for a type), and holds no
    `+  name: gorilla-service`. *Fails today:* the diff writes it at exit 0, signed by
    `inspected()`.
  - `tests/unit/trace-builder.test.ts`: an `unwitnessed` event is one note on the Inspector's
    span, and `tests/support/trace.ts`'s `disagreements` finds none. *Fails today:* no note is
    drawn on the Inspector's span. Vitest does not typecheck, so the unknown event type runs,
    and the builder's `default` (`src/trace/builder.ts:369-372`) returns without drawing
    anything; `pnpm typecheck` is red too until Step 4, which is expected.

- [x] **Step 4: Build it.** `read()` in `buildProjectTools`. `project-witness.ts`. In
  `inspectRepository`: `const before = tools.read().length` at the top of each turn, and on an
  accepted report `witnessFacts(parsed.data, tools.read().slice(0, before))`, emitting each
  `unwitnessed` event before `facts` is returned. The `undetermined` path emits none, and is
  handed the engine's fixed reason while the `refused` event keeps the model's words. Add the
  event, its `renderEvent` line and its trace note: both switches are exhaustive, so a missing
  case does not compile. Steps 2 and 3's tests pass.

- [x] **Step 5: The fixtures that scripted an unwitnessed Inspector.** These are the 62 tests in
  the table above. Each is made to read a file that states what it reports. No assertion is
  loosened, and none is deleted. `init-command.test.ts`'s *still writes the name the inspection
  did read* and *vouches for a fact at the field it was read for, and nowhere else* stay
  meaningful because the files now state those facts. Run each file, then `pnpm typecheck`.

- [x] **Step 6: The docs it makes true** (below), the CHANGELOG line, the roadmap, the review's
  Status and the test count. `docs/plans/inspector-witness.md`'s status line becomes "built".

- [x] **Step 7: The whole check.** `df -h /`, then `pnpm typecheck`, `pnpm test`, `pnpm build`
  and `pnpm smoke`. Everything is green except `link-already-declared`, which fails with
  "prompt changed since recording" and nothing else. It is written in the pull request as
  waiting for the owner's key.

- [x] **Step 8: The owner's re-record** of `link-already-declared` (question 1), on the branch,
  with the command in [`tests/README.md`](../../tests/README.md#when-your-change-stales-one).
  Read the new tape before it is committed. `pnpm test` with no key is then green.

**What the owner can run**, keyless, from the branch's checkout:

```bash
pnpm vitest run tests/unit/inspector.test.ts -t "2026-10-02"
pnpm vitest run tests/unit/project-witness.test.ts
pnpm vitest run tests/unit/plan-intent.test.ts tests/unit/init-command.test.ts -t "invented"
pnpm vitest run tests/scenarios/plan-mode.test.ts
pnpm test
```

Attendu :

- the first prints `Tests  1 passed`, the rest skipped: the invention withdrawn;
- the second prints `Tests  1 passed`: a rule for every field the report carries;
- the third prints `Tests  2 passed`, the rest skipped: the plan road's opening holding no
  invented value, and `init` asking rather than writing;
- the fourth, before the re-record: `1 failed`, `link-already-declared: the recording is stale —
  re-record it`, and every other test passed; after it: all passed;
- the fifth, after the re-record: every test passed, with the count the pull request states.

And to record the one stale tape, the key loaded from the owner's `.env` in a subshell, so it
is gone when the subshell ends (the model is the one the other tapes were recorded with):

```bash
(set -a; source /Users/pierrecaboor/Documents/idp-agent/.env; set +a; cd /Users/pierrecaboor/Documents/idp-agent-worktrees/inspfix && IDP_PROVIDER=openai IDP_MODEL=gpt-6-luna IDP_RECORDING=record pnpm vitest run tests/scenarios/plan-mode.test.ts -t "link-already-declared: the access is in the repository already")
cd /Users/pierrecaboor/Documents/idp-agent-worktrees/inspfix && pnpm vitest run tests/scenarios/plan-mode.test.ts
```

Attendu :

- the first writes `tests/recordings/link-already-declared.json` and prints `Tests  1 passed | 9 skipped (10)`;
- the second, with no key, prints `Tests  10 passed (10)`, with no "prompt changed since recording".

### As built

Built on `main` at `4a4eb20`, test first; every new test was seen failing for its stated
reason, or passing where the plan says it passes today, before the code. Where the code or the
run differed from the plan:

- **No section "Where the code moved since the note" exists in this plan**; every file and line
  it names was where it said on `4a4eb20`, bar line numbers moved by #139 in files this task does
  not touch.
- **Test 5 failed first one step earlier than the plan says**: with no `unwitnessed` event emitted
  at all, the line under test was `undefined`, not the object `renderEvent`'s `default` hands back.
  It now passes. Its second half follows `said`, the cleaner every reason on the stream goes
  through: an ESC sequence is **removed** (`plain`), not spelled out, and a U+202E is spelled
  `\u202e`; both on one line. The plan's "prints it spelled out" holds for the bidi control only.
- **`trace-wiring.test.ts`**: the one failing test (*is the text without a terminal's escape
  sequences…*) and the `init` road of *a memory sink changes nothing a person sees* (green either
  way, but it would have compared two runs that ask instead of two that reach a diff) both read
  `package.json`, a `README.md` keying type, lifecycle, runtime and owner, and a `CODEOWNERS`.
- **`key-reach.test.ts`**: the wire answers the Inspector's first request with `read_file` of a
  `README.md` that keys every value `FACTS` reports, the name included, and reports on the next;
  per run, so every road and provider gets the same two turns.
- **`init-real-repo.test.ts`**: `SIGNALS`' `README.md` gains the three keyed lines, and `drafting`
  reads `package.json`, `README.md`, `CODEOWNERS` and `Dockerfile` (the runtime `node` is
  `FROM node:22-alpine`'s) before it reports; the file count and the budget are unchanged.
- **The 62** were 4 in `inspector.test.ts`, 29 in `init-command.test.ts`, 18 in
  `init-real-repo.test.ts`, 9 in `key-reach.test.ts`, 1 in `trace-wiring.test.ts` and the stale
  tape, as measured. No assertion was loosened or deleted.
- **The roadmap's queue item 1 is marked done**, not half done: #139 shipped its other half before
  this pull request. *Recordings that need the owner's key* does not gain `link-already-declared`,
  because the owner records it on this branch before the merge.
- **No architecture rule moved**: `pnpm vitest run tests/architecture` reports the same 47 tests.
- **After the review of the built change**, four additions, each test seen failing first (or,
  for a pin of code already right, failing under a mutation of that code):
  - *A value folding would change is stated by no file* (`plain` in `project-witness.ts`).
    `echoes` compares folded and the kept value is the model's, so `serv\u00ADice` (a soft
    hyphen), a full-width `service`, `\u202Enode` or `node\u2010js` were kept from `type:
    service`, `runtime node` or `node-js`, and `init` wrote bytes no file held at exit 0. A value
    holding a control or format character, one NFKC rewrites, or one `fold` changes in anything
    but its case is now withdrawn, even beside a file holding the same bytes. Six rows of
    *states a value by the field’s rule*; a seventh pins the limit left, case: `Service` is kept
    from `type: service`, and the diff shows it as reported.
  - *An empty dependency list is withdrawn when no file was read*, with the engine's reason
    `the Inspector read no file, so nothing establishes that this repository declares no
    dependencies` and one `unwitnessed` event whose value is `(none declared)`, as the Architect
    would have read it. Once any file was read, an empty list is kept, a limit pinned by *keeps an
    empty list once a file was read* and named in `SECURITY.md`. No tape reports an empty list.
  - *Decision 3 is tested*: *makes the whole list unknown when one name in it is unstated* reads
    `pg`'s manifest, reports `[pg, redis]` and expects the list unknown with `1 of the 2`, and
    exactly the two events `dependencies.1.name` (`redis`) and `dependencies` (`pg, redis`). It
    fails if only a list whose every name is unstated is withdrawn.
  - *A path is no witness, pinned where it could be one*: the row *no runtime, from a path
    list_files gave* lists and reads `node/README.md` (`hello`) and reports the runtime `node`,
    a token of that path. It fails if `list_files`' output counts as a read file; the earlier
    name row could not, since a path holds no `name` key.
  - Design §6.2's union and `docs/tracing-design.md`'s table of the facts the trace reads gain
    the `unwitnessed` event.

**The one failure left, until the owner's re-record (Step 8)**, and nothing else fails: in
`tests/scenarios/plan-mode.test.ts`, `plan "<intent>" > link-already-declared: the access is in
the repository already`, with `link-already-declared: the recording is stale — re-record it`,
its stderr carrying `recording link-already-declared architect turn 0` to `turn 3`: *the prompt
changed since recording; replaying anyway*. The Inspector's turns and the Reviewer's turn replay
unchanged; `prompt-digests.test.ts` is green, and the other eleven tapes replay with the bytes they
had, with no such line. `tests/recordings/` is unchanged.

*Step 8, done by the owner on 2026-10-04* with OpenAI `gpt-6-luna`: the Inspector lists the
files, reads `package.json`, reports `billing-api`, and gives every other field as an unknown
with its reason — `pg`'s category included, which no file states — so the Architect is sent no
classification the model made. `plan-mode.test.ts` is 10 out of 10 with no stale line, and the
whole suite is green.

---

## The docs it makes true

- **`AGENTS.md`**, *The trust boundary*: after the `Answer`'s witness paragraph, two sentences.
  A value the Inspector reports reaches the Architect and `init`'s signature only where a file
  it read states it, by the field's rule; otherwise it is an unknown with the engine's reason,
  said on stderr, and asked where a proposal carries it. The reason a model writes for a field
  it marks unknown is not checked, and reaches the Architect as written, bounded at 8,192
  characters, until question 5's answer closes it. The test count is re-measured.
- **`docs/design.md`**: §5.1 gains the same sentence beside the `Answer`'s witness. §7.3's "The
  signature says a proposed value matches what the inspection established" becomes "…matches
  what a file the Inspector read states". Its "A field no file states is asked at a terminal"
  is now true, and is kept.
- **`SECURITY.md`**, the table of guarantees: a row "A value the Inspector reports reaches a
  model or the signature only where a file it read states it; a package.json the model wrote
  itself is read by nobody", pointing to Step 2's tests 1, 4 and 6, and to Step 3's two
  (*Guaranteed today, with the test that enforces it*, `SECURITY.md:237`). *Known to be
  incomplete* (`:313`) gains the rest: "the reason a model gives for a field it marks unknown
  is passed to the Architect as written, bounded at 8,192 characters", pointing to Step 2's
  test 7, and the keyed rule's pinned limits (any `name` line, an environment variable's key,
  a one-line file).
- **`src/agents/README.md`** and `project-tools.ts`'s comment (`:64-67`): the witness, and what
  it does not give. A file can state a wrong value, so a witnessed fact is "some file says so",
  never "true". The diff and the merge are still where a person judges it.
- **`docs/stage-8-brief.md`**, § 5 (`:309-318`) and slice 2's item 1 (`:731-733`): the witness
  is in place. Item 1 still takes the facts off `answers` and makes them hints. This pull request
  narrows what `init` places as `answered` to "a value a file the Inspector read states", and
  does not close that class (question 4). § 5's *Free text in a prompt* names the second
  channel beside `dependencies[].name`: the reasons a model writes for its own unknowns. If the
  owner answers question 5 "at stage 8", slice 2's item 2 (`:734-737`) gains "and the
  Inspector's unknown reasons become the engine's", riding the re-record of the same five tapes.
- **`docs/roadmap.md`**: queue item 1 becomes half done, naming this pull request. The Behaviour
  debt *What the Inspector reports is not held to the files it read, on the plan road too* is
  removed. The `init` line under *Left from the sweep of the review* loses security-5 and
  gap-init-real-repos-5. If the re-record is not done before the merge, *Recordings that need
  the owner's key* gains `link-already-declared`.
- **The review's Status**, *Beyond the priorities*: security-5 and gap-init-real-repos-5 →
  #PRNUM.
- **`CHANGELOG.md`**, Unreleased, Fixed: the line, ending with
  `([#PRNUM](https://github.com/pcaboor/idp-agent/pull/PRNUM))`. It names the open reason
  channel as plainly as the check.

`plan-mode.test.ts`'s *holds an Inspector that reports what a file it read says* stays. It now
guards the tapes, and Step 2's tests guard a live run.

---

## Questions for the owner

All five settled by the owner on 2026-10-03, each as recommended (recorded in
[`docs/roadmap.md`](../roadmap.md)'s decisions). The text below keeps each question as it was put.

1. **Settled: `link-already-declared` is re-recorded by the owner in this pull request.** Its Inspector
   reported `pg: database`, which no file states. Holding a dependency's type to the files
   changes one line of the Architect's opening. No rule that holds the invariant avoids that:
   all three candidates were measured. **Recommended: yes.** Hold every field now, and record
   that one tape again on the branch before the merge (eight turns of `gpt-6-luna`). The
   alternative is to leave a dependency's type unchecked until stage 8's slice 2, item 2, which
   removes `dependencies` and re-records all five plan-mode tapes anyway. That stales nothing
   now, but keeps sending a model's classification to the Architect as established, against
   "declare, never infer", for one more stage. If you choose that: `WITNESS_RULES.dependencies`
   checks names only, and the measurement table loses its stale row.
2. **Settled: withdrawn after the report, never handed back to the Inspector.** **Recommended: post hoc**,
   as planned. A retry costs a model turn whenever a fact is withdrawn, stales any tape where it
   fires, and teaches the model to find a word it can quote. If you prefer a retry: the loop's
   repair path (`inspector.ts:220-238`) gains a witness refusal, and test 1 expects a second
   report.
3. **Settled: one unstated dependency name makes the whole list unknown, rather than keep the stated entries?**
   **Recommended: the whole list unknown**, with the count in the reason. A list that has lost an
   entry reads as complete. No tape is affected: every tape's `pg` is stated. If you prefer to
   keep the stated entries: `formatFacts` needs a line saying how many were withdrawn, which
   changes no tape either.
4. **Settled: on `init`, a witnessed fact still signs as `answered` until stage 8.** **Recommended:
   leave it to stage 8's slice 2, item 1**, which makes the facts hints and asks more. This pull
   request keeps a model's invention from signing, which is the defect. Taking the facts off
   `answers` here would change `init`'s questions on every run, which is that item's scope and
   its UX. If you want it now: `inspected()` goes, and every `init` test that expects a silent
   name expects a question.
5. **Settled at stage 8: the reason a model writes for its own unknown, engine-written then, not now or at stage 8?** The
   witness holds values; `runtime: { unknown: "<any 8,192 characters>" }` still reaches the
   Architect as written (see the Goal). Closing it means `formatFacts` prints a fixed reason per
   field, for example `unknown (the Inspector did not establish it)`, and never the model's.
   Every Architect opening of the five Inspector tapes carries such reasons, so it stales all
   five, not one. **Recommended: at stage 8**, in slice 2's item 2, which removes `dependencies`
   from the same opening and re-records the same five tapes anyway, so the reasons change for
   free there. This pull request stays at one stale tape, states the limit in the Goal,
   `AGENTS.md` and `SECURITY.md`, and pins it with Step 2's test 7. If you want it now: the
   fixed reasons go into `witnessFacts` (so `formatFacts` still does not change), test 7 flips
   to expect them, `architect.test.ts`'s byte pin changes with the tapes, and Step 8 becomes the
   re-record of five tapes (48 recorded turns of `gpt-6-luna` today) instead of one (8).
