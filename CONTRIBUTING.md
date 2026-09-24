# Contributing

## Setup

```bash
pnpm install
pnpm test
```

That is it. Node >= 22 and pnpm 10, nothing else — no API key, no network, no Docker,
no database. If a change makes any of those necessary to run the suite, the change is
wrong, not the setup.

Before opening a pull request, run what CI runs:

```bash
pnpm typecheck    # vitest does not typecheck; this is not redundant
pnpm test
pnpm build
pnpm smoke        # runs the built dist/cli/bin.js, which the suite never does
```

**Neither leaves anything in the temp directory.** A test that needs one calls
`os.tmpdir()` as usual: for the whole run it answers a single directory,
`idp-agent-test-<pid>-…`, which `tests/setup/tmp.ts` removes when the run ends — files a
test locked with mode 000 included — and `pnpm smoke` removes its own. There is nothing to
clean up by hand, and `tests/unit/temp-directory.test.ts` fails if that stops holding.

**`pnpm typecheck` is not a formality.** A green suite has already hidden a resource type
that does not exist, an `undefined` passed where the property is optional, and a dead
import — vitest strips types, it does not check them. The config is deliberately strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`,
`noUnusedParameters`): if your editor shows a diagnostic the CI does not, that is a gap in
the config, not noise to ignore. Close it.

## How the work is organised

Each stage has a plan in [`docs/plans/`](docs/plans), written before any code and
executed task by task, test first. Read [`AGENTS.md`](AGENTS.md) before touching
anything — it is the shortest path to the architecture and the invariants, and it says
what is already built.

**Test first.** Write the failing test, watch it fail for the right reason, then write
the smallest code that passes. A test that never failed proves nothing about the code;
it only proves the test runs.

## The rules CI enforces for you

No human has to explain these in review — the build does it, with a message:

- `core/` imports neither `agents/`, `llm/`, the disk, the network nor the model SDK.
- `agents/` imports neither `fs`, nor `child_process`, nor a git client — **and nothing
  reachable from it does either**. The test walks the transitive import closure, so there
  is genuinely no code path from an agent to the disk. That is structural, not a
  convention.
- Only `llm/` imports the model SDK, and `agents/` imports `llm/client.js` and nothing
  else from it — which is why that file holds types only.
- `scaffold/` imports `core/` and nothing else of ours, and exactly one module in it
  writes.
- Everything typechecks under TypeScript 7 with the project's strict settings.
- The built binary runs, returns the right exit codes, and the packaged tarball carries
  what it needs — `pnpm smoke` reads `npm pack` output, because green tests once hid a
  package with no templates in it.

Add a rule when you add a layer. `tests/architecture/dependencies.test.ts` is the place.

## What review looks at instead

The invariants in [`docs/design.md`](docs/design.md) §4. They are not style preferences:
each has a known cost when violated, and none follows from the documentation of the
tools involved. A change that weakens one needs to change that section first, with the
reasoning — not in a pull request description that nobody will find again.

The two that catch most newcomers:

- **Declare, never infer.** What is unknown is reported as unknown, never filled with a
  plausible value. An ambiguous name lists its candidates; it does not pick the first.
- **Never ignore in silence.** An entity that fails validation is reported. Dropping it
  quietly is the catalogue behaviour this tool exists to compensate for.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org): `feat(cli): …`,
`fix(context): …`, `docs: …`, `test(core): …`, `ci: …`.

Write the body for whoever reads it in a year: what was wrong, why this is the fix, and
what you decided against. `main` is reached through a pull request — the repository
holds its own doctrine about merges being the act of authorisation, and applies it to
itself.

**English throughout** — code, comments, commit messages, test names, CLI output.

## Reporting a bug, or a vulnerability

Bugs: open an issue with the command you ran and what you expected. Vulnerabilities:
see [`SECURITY.md`](SECURITY.md) — a private advisory, not a public issue.

## Licence

By contributing, you agree that your contributions are licensed under Apache-2.0, the
licence of the project.
