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

## Armed, and enforced the day the code lands

These rules are written as tests now and pass vacuously, because the directories they
guard do not exist yet. They fail the build the moment someone creates them and gets it
wrong — which is the point of writing them first.

- **Agents get no write access.** `agents/` may not import `fs`, `child_process` or a
  git client (`tests/architecture/dependencies.test.ts`). The guardrail is structural:
  there is no code path from an agent to the disk.
- **`core/` stays free of the model.** It may not import `agents/` or `llm/`.

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
