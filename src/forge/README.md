# `forge/` — where a submission becomes a branch

The layer that will write into a user's repository: one new ref under `refs/heads/idp-agent/`,
cut through git's plumbing, and nothing else (ADR-0010). Today it holds its shapes and its
refusals; the local forge itself is stage 5's next task.

## What lives here

| file | what it is |
|---|---|
| `provider.ts` | `ForgeProvider`, `Base`, `Submitted` — **types only**, like `llm/client.ts` |
| `errors.ts` | `ForgeInputError` — the refusals that are the user's arguments, exit 2 |

## What a forge can do, and what it cannot

`ForgeProvider` has three methods — `base`, `diverges`, `submit` — and the absences are the
design. There is no `merge`: the merge is the act of authorisation (ADR-0006), and a method
nobody calls is not a guarantee. There is no `delete`, no push to a base and no way to name
a branch: `submit` takes a `Cleared`, whose branch the engine computed from its bytes, and a
ref can only be created, never moved — `main` included. A forge is opened for one
repository, and a clearance of the other is refused before anything else.

Nothing in `forge/` checks out, stages, or touches a working tree, the index or `HEAD`: a
submission writes git objects and one ref, and before the ref nothing observable exists.

## What may not

`forge/` imports `core/` and `process/` and nothing else of ours, no package at all — a
git client the rules do not name would pass every other rule — and of Node's built-ins only
`node:crypto` and `node:path`: a forge that read a file or opened a socket of its own would
be a way out no other rule sees. It starts no process of its own: every git call goes
through `process/git.ts`, which it is one of two to load. Only `cli/` reaches it at run
time, however many hops away — a module that imports a `cli/` module importing the forge
reaches it too; another layer may name its types with `import type`, which is erased. `core/` may not import
it at all — `Cleared` is core's, so that would be a cycle. The rules are in
`tests/architecture/dependencies.test.ts`: *forge/ imports core/, process/, node:crypto and
node:path, and nothing else*, *only cli/ reaches forge/ at runtime*, *only context/project-fs
and forge/ load the git launcher*, and *core/ imports nothing from
context/, cli/, scaffold/, forge/ or process/*.
