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
| `scenarios/` | the whole chain against a recorded model: `plan-mode.test.ts` and `question-mode.test.ts` |
| `recordings/` | the tapes those two replay, one JSON file per scenario |
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

## The tapes

A tape is every model call a scenario made, the day it was recorded: for each turn, its
key — scenario, agent, turn number — the provider and model, the request it sent (`call`),
what came back (`result`) and a `digest` of the request. A replay looks each turn up by its
key, never by its digest, and hands the recorded answer to the real harness: the agents'
loops, the tools, the gates, the renderers all run for real.

- **A turn the tape does not hold is fatal**: `no recording for <scenario> <agent> turn <n>`.
  A new scenario, or a change that makes an agent take a turn more, fails until it is
  recorded.
- **A turn whose request changed warns** — `the prompt changed since recording; replaying
  anyway` — and replays the old answer. That answer was given to a request the code no
  longer sends. `scenarios/plan-mode.test.ts` turns the warning into a failure, naming the
  scenario: `the recording is stale — re-record it`. `scenarios/question-mode.test.ts` does
  not yet, and its tapes are stale today ([`docs/roadmap.md`](../docs/roadmap.md), "Recordings
  that need the owner's key").

### What makes a tape stale

The digest is taken over the whole request an agent builds (`digestOf` in
`src/llm/runtime.ts`), so anything that changes what a model is sent changes it:

- an agent's system prompt, or the wording of a message the harness writes into the
  transcript — an opening message, a repair report, a refusal's text;
- a tool's name or description, or what a tool returns;
- a fixture a scenario reads: the Inspector's `read_file` results and the Architect's search
  results are in the transcript;
- one changed turn: turn *n* carries turn *n − 1*'s answers, so every later turn of that
  agent warns too.

What does not: the timeout, and part of a tool's schema. The digest holds the tool's Zod
schema as `JSON.stringify` writes it, which keeps its fields and drops a `.max()`, a
`.regex()` or a `.describe()`; such a change reaches the provider and stales a tape with no
warning (review agents-llm-9, batch B2 in the roadmap).

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
- The tape is written when the run ends, merged into the old one: a turn the new run did
  not take stays in the file (review tests-5, batch B2). Check the diff for turns that no
  longer belong.
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
