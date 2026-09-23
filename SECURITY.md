# Security

The project's whole point is to write to an infrastructure repository on someone's
behalf. So the threat model is stated here rather than left to be asked about.

**Read this first:** the repository is at **stage 1 of 7**. It ships two read-only
commands. There is no model, no network call, no write path and no token handling in
the code yet. This file separates what is **guaranteed and tested today** from what is
**designed and not yet built** — a guarantee that is not enforced by a test is not
claimed here.

## Guaranteed today, with the test that proves it

| Guarantee | Enforced by |
|---|---|
| No path outside the repository is reachable | `tests/invariants/core.test.ts` — *every computed path stays inside the repository* (property-based, `fast-check`) |
| A traversing or nested entity name is refused, not sanitised | `tests/unit/entity-path.test.ts` — `PathEscapeError` on `../../etc/passwd`, `a/b`, `.hidden` |
| A `Plan` carrying an unknown field cannot be applied | `tests/unit/plan.test.ts` — `isApplicable` is false and the dotted path is reported |
| A `Plan` is bounded: 50 operations, 32 levels of nesting, 10 000 nodes, 8 KB values, a 2 000-character intent | `tests/unit/plan.test.ts`, `describe('plan limits')` |
| A deeply nested structure cannot exhaust the stack | `tests/unit/plan.test.ts` — `findUnknowns` walks 50 000 levels iteratively |
| `__proto__` from parsed JSON is dropped, not merged into the prototype | `tests/unit/plan.test.ts` |
| `core/` never reaches the network | `tests/architecture/dependencies.test.ts` |
| An entity that fails validation is reported, never dropped in silence | `tests/unit/fixtures-provider.test.ts`, `tests/unit/main.test.ts` |
| The suite needs no API key, no network and no Docker | it is the whole of CI: five commands, offline |
| A duplicate entity is refused before the merge, naming **both** files | `tests/unit/validate-rules.test.ts` — the catalogue would keep the first and say nothing |
| An entity filed where its type and name do not put it is refused | same, `misplaced-entity`, compared against `resolveEntityPath` |
| A folder holding entities with no witness is refused | same — a pattern with no match must fail, not return an empty set |
| `init platform` never overwrites and never deletes | `tests/unit/scaffold-write.test.ts` — `flag: 'wx'`, and a hand-edited `CODEOWNERS` survives a re-run byte for byte |
| A model cannot make the tool state an unread fact | `tests/unit/analyst.test.ts` — every reference an answer names must be in the witness set of what the tools returned |

These were written before the directories they guard existed, and passed vacuously until
stage 2 filled them. They now hold over real code:

- **Agents get no write access.** No module **reachable from** `agents/` may import `fs`,
  `child_process`, a git client or the network — the test walks the transitive import
  closure, so `agents/` to `llm/client` to `recording` to `node:fs` fails the build rather
  than passing a grep. It is why `llm/client.ts` holds types only and the recording store
  lives in `cli/`. Verified non-vacuous against exactly that shape before being relied on.
- **`core/` stays free of the model.** It may not import `agents/`, `llm/`, the disk, the
  network or the model SDK, and only `llm/` may import the SDK at all.
- **One module writes.** In `scaffold/`, only `write.ts` imports a writing function — the
  seam a future applier replaces, kept to one file so it stays reviewable.
- **The suite cannot reach the network.** `tests/setup/offline.ts` replaces
  `globalThis.fetch` with a thrower unless `IDP_RECORDING=record`. Structural, not a
  convention: a forgotten recording fails loudly instead of quietly calling a provider on
  whoever's key is in the shell.
- **A model cannot make the tool state an unread fact.** Every reference an answer names
  must be in the witness set of what the tools actually returned, or the answer is refused
  and the reference named (`tests/unit/analyst.test.ts`). Model-authored text that does
  reach a terminal is stripped of everything a terminal obeys first
  (`src/cli/render/plain.ts`): a `{unknown}` reason is up to 8 192 characters the model
  wrote, and one carrying `ESC[2J` cleared the screen and printed a fake diff under the
  tool's own closing line.

## What the architecture rules are, and are not

They walk **string-literal imports** across the transitive closure. That catches the
threat they name — a contributor who adds an import without noticing where it lands — and
it is not a sandbox. `globalThis.fetch`, `process.binding`, `eval` and
``import(`node:${name}`)`` need no import at all, and a specifier the regexes do not list
(`node:dns`, `node:vm`, `ws`, an `ai/` subpath) passes. Read them as a build-time
convention with teeth, never as a boundary that contains hostile code in this repository.

The boundary that does contain something is `context/project-fs`: it decides what leaves
a user's own repository for a third-party model, and it is enforced at runtime rather than
at build time.

## Designed, not yet built

Claimed by `docs/design.md`, not by the code. Do not rely on them today.

- **The merge is the act of authorisation** — the CLI opens a merge request and never
  writes to the main branch (stage 5-6).
- **Separate tokens per capability** — the token that opens a merge request cannot merge
  it, and a negative test will assert that this action *fails* (stage 6).
- **No secret reaches the model** — the Inspector is confined to the current repository;
  escaping paths refused, `.env`, `.git/` and key files excluded, size capped (stage 4).
- **Every anti-destruction check is repeated engine-side**, at the moment of acting. A
  control that only lives in the client controls nothing.

## Not guaranteed, by design

- **Content proposed by the model may be wrong.** Review decides. The tool exists to
  produce a reviewable merge request, not to be trusted unread.
- **A prompt injection carried in a repository file can steer a proposal** — but it
  cannot widen permissions. The action surface is fixed at build time: `Operation` is a
  closed discriminated union with no delete operation, the model emits a structure and
  never a line of YAML, and the engine — not the model — chooses the file path. An
  injection can produce a bad proposal; it cannot produce an unmodelled act.
- **The catalogue lags the repository** by about two minutes. The repository, not the
  catalogue, is the source of truth at write time.

## Reporting a vulnerability

Open a private security advisory through the repository's **Security** tab
(*Report a vulnerability*). Please do not open a public issue for something exploitable.

Since there is no deployed service and no write path yet, the interesting surface today
is the path handling in `src/core/paths/` and the bounds in `src/core/schemas/plan.ts`.
