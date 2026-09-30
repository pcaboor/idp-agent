# tests/

`pnpm test` runs everything here with no key, no network and no Docker. This file is about
the one part of the suite that was made with a key: the tapes in `recordings/`, what makes
one stale, and what to do when your change does.

| Folder | What it holds |
|---|---|
| `unit/` | one module or one command at a time; an agent-backed command is driven by a scripted client (`MainDeps.client`), never by a tape |
| `contract/` | what each provider is sent over HTTP, with `fetch` stubbed |
| `architecture/` | the import rules of `AGENTS.md`, and checks that they cannot pass on an empty tree |
| `invariants/` | properties over generated input (`fast-check`) |
| `golden/` | small catalogues the unit tests read, each built for one case |
| `scenarios/` | the whole chain against a recorded model: `plan-mode.test.ts`, `question-mode.test.ts`, and `backstage-mode.test.ts`, questions over the fake Backstage |
| `recordings/` | the tapes those three replay, one JSON file per scenario |
| `setup/` | what runs before every test file, below |
| `support/` | helpers shared by tests; `fake-backstage.ts`, the fake catalogue as an injected `fetch`, below |

## Before every test file

`vitest.config.ts` runs three setup files, in this order, and a global one:

- `setup/shell.ts` removes every `IDP_` variable but `IDP_TRACE_DIR`, and every `*_API_KEY`:
  the README asks you to export `IDP_PROVIDER` and `IDP_MODEL`, and the suite must pass the
  same with them as without. A scenario being recorded keeps them all, and is the only file
  that may record.
- `setup/offline.ts` makes `fetch`, `node:http`, `node:https`, `node:net`, `node:tls` and
  `WebSocket` throw "the test suite reached the network", everywhere but in a scenario being
  recorded.
- `setup/personal.ts` hides your `IDP_REPO`, your MLflow variables and your
  `~/.config/idp-agent/config.yml`.
- `setup/tmp.ts` points the temp directory at one directory per run, removed at the end.

`unit/offline.test.ts` and `unit/personal-config.test.ts` fail if any of that stops holding.

## The properties

`invariants/` draws its input at a seed fast-check picks per run, so every run explores input
the last one did not. A property that fails prints `{ seed, path }`; handed to that
`fc.assert`, they replay the counterexample. Every file of properties imports
`invariants/budget.ts`: a test there may run 60 seconds, and fast-check stops at 50 and
reports the stop as a failure naming its seed, so a run slowed by a busy machine is never a
bare "timed out" nobody can replay. Each property also counts what it met — plans the signer
accepted and what they held, files written by hand, edits made into them — and fails under a
floor set far below what many seeds measured: a generator that stops drawing a shape turns a
property red instead of vacuous. A floor is checked after `fc.assert` returned, where
fast-check names no seed, so those properties draw theirs with `freshSeed()` and each floor's
message names it. The files are drawn written by hand, every trait on its own
(`arbitraries.ts`), and `core.test.ts` asserts each trait is drawn, by a check no other trait
satisfies.

## The fake Backstage

A catalogue is never reached over a socket here. `tools/fake-backstage.ts` serves a folder of
YAML (`fixtures/si-demo` by default) as Backstage serves it — a namespace, a uid, an etag,
`relations[]` and the two locations the catalogue sets on every entity, `spec` as written —
and pages as Backstage pages: the cursor carries the filter, the position and `totalItems`,
`limit` and `fields` are read from each request, 200 when none is sent, with no cap.
`support/fake-backstage.ts` hands its `handler` to the transport as the `catalogueFetch`,
keeps every request in `sent`, and answers the faults a test names — a status, a hang, a
cursor seen twice, a uid served on two pages, a `totalItems` above what is served, an item
added to a page that its read did not ask for. Every test
above the transport reads a catalogue through it (`unit/backstage-*.test.ts`), and
`unit/fake-backstage.test.ts` holds it to Backstage's paging. Run as a program,
`node tools/fake-backstage.ts` (Node 22.18 or later) listens on `127.0.0.1:7007` for the demo;
no test starts it, and what it answers one request, a request no `Request` can be built
from included, is `answerOf`'s, tested apart from the socket.

The fake is held to a real one by `contract/backstage-page.test.ts`: `contract/backstage/`
keeps one `by-query` page recorded from Backstage 1.55.2, the demo Backstage in Docker
(`tools/backstage/`), which must load as the demo SI's files read, and which the pre-pass and
`readValue` must read as they read the fake's page for the same files. `pnpm demo:backstage:docker --record` re-records it; nothing in the
suite starts Docker.

## The tapes

A tape is every model call a scenario made, the day it was recorded: for each turn, its
key — scenario, agent, turn number — the provider and model, the request it sent (`call`),
what came back (`result`) and a `digest` of the request. A replay looks each turn up by its
key, never by its digest, and hands the recorded answer to the real harness: the agents'
loops, the tools, the gates, the renderers all run for real.

- **A turn the tape does not hold is fatal**: `no recording for <scenario> <agent> turn <n>`.
  A new scenario, or a change that makes an agent take a turn more, fails until it is
  recorded.
- **A turn the run never reached is fatal too**, once the run has succeeded:
  `recording <scenario>: <agent> turn <n> was never replayed`. A change that makes an agent
  take a turn less fails the same way, and a tape cannot keep a turn no scenario plays —
  nor a second entry for one turn, whose earlier copy is named `an earlier <agent> turn <n>`.
- **A turn whose request changed warns** — `the prompt changed since recording; replaying
  anyway` — and replays the old answer. That answer was given to a request the code no
  longer sends. `scenarios/plan-mode.test.ts` turns the warning into a failure, naming the
  scenario: `the recording is stale — re-record it`, and so does
  `scenarios/backstage-mode.test.ts`. `scenarios/question-mode.test.ts` does not yet, and
  its tapes are stale today ([`docs/roadmap.md`](../docs/roadmap.md), "Recordings that need
  the owner's key").

### What makes a tape stale

The digest is taken over the request as a provider is shown it (`digestsOf` in
`src/llm/runtime.ts`): the system prompt, the transcript, the tool choice, and each tool's
name, description and advertised JSON Schema. Anything that changes what a model is sent
changes it:

- an agent's system prompt, or the wording of a message the harness writes into the
  transcript — an opening message, a repair report, a refusal's text;
- a tool's name or description, a field's `.describe()`, a `.max()` or a `.regex()`, or what
  a tool returns;
- a fixture a scenario reads: the Inspector's `read_file` results and the Architect's search
  results are in the transcript;
- one changed turn: turn *n* carries turn *n − 1*'s answers, so every later turn of that
  agent warns too.

What does not: the timeout, and the settings of a call that are not part of the request.

That is a turn recorded since 2026-09-30, whose digest starts `sent:sha256:`. A turn
recorded before holds a `sha256:` digest, taken over the request as the agents build it,
with each tool's Zod schema as `JSON.stringify` writes it: its fields are there, a `.max()`,
a `.regex()` and a `.describe()` are not, so such a change still stales that turn with no
warning. It cannot be moved to the new digest without a key: the tape stores neither the
tools nor the tool choice it was sent, and its transcript was stored as it grew after the
call (review tests-6, wip-diff-12). The replay compares each turn with the digest in its own
scheme, so an old turn keeps the verdict it had until it is recorded again.

### When your change stales one

First ask whether it should. A refactor that changes what a model is sent is a change in
behaviour, even when every test passes: undo the part that reaches the request, or keep it
and say so.

When it must — a prompt made clearer, a fact the Reviewer was denied — the tape has to be
recorded again, which needs a key and costs money. Never edit the tape by hand to make the
warning go away: a turn nobody recorded is what the `handAuthored` flag exists to refuse,
and `the recordings themselves` in `plan-mode.test.ts` checks no tape carries one. Either
record it, below, or say so in the pull request and let the change wait: the owner keeps
the changes waiting for a re-record in [`docs/roadmap.md`](../docs/roadmap.md), under
"Recordings that need the owner's key".

To record, with your own key or the owner's, one scenario at a time:

```bash
IDP_PROVIDER=openai IDP_MODEL=<model> OPENAI_API_KEY=… IDP_RECORDING=record \
  pnpm vitest run tests/scenarios/plan-mode.test.ts -t '<the test name>'
```

- Only a file under `tests/scenarios/` records; everywhere else the variables are removed and
  the network stays closed. `-t` keeps the run to the scenario you name: recording calls the
  model for every turn of every scenario it runs, with no replay.
- The tape is written when the run ends, from an empty one: it holds the turns the new run
  made and nothing of the file it replaces (review tests-5). A run that fails writes
  nothing.
- Read the new tape before committing it. It holds every file the Inspector read, verbatim;
  `carries no credential` fails on a header's name, key material, a secret's assignment or a
  known token's shape, not on everything a file can hold.
- Run `pnpm test` without the variables afterwards: the replay has to pass with no key.

## The audit's oracle

`docs/audit-attacks/` holds the tests of the 2026-09-23 audit. Each asserts a defect, so a
passing test there is an open defect and a failing one a closed defect, and a test that
crashes counts as neither. They never run under `pnpm test`:

```bash
pnpm vitest run --config docs/audit-attacks/vitest.config.ts
```
