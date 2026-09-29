# `forge/` — where a submission becomes a branch

The layer that writes into a user's repository: one new ref under `refs/heads/idp-agent/`,
cut through git's plumbing, and nothing else (ADR-0010). It holds its shapes, its refusals and
the local forge; `plan --from … --submit` reaches it, through `cli/commands/submit.ts`.

## What lives here

| file | what it is |
|---|---|
| `provider.ts` | `ForgeProvider`, `Base`, `Submitted` — **types only**, like `llm/client.ts` |
| `errors.ts` | `ForgeInputError` — the refusals that are the user's arguments, exit 2 |
| `local/objects.ts` | `blobId`, `treeOf`, `writeTree` — reading and writing git objects, never a ref |
| `local/forge.ts` | `openLocalForge(repo, repository)` — `base`, `diverges`, `submit`, over a clone on this machine |

## How a submission is atomic

A submission becomes visible at exactly one point: `update-ref <ref> <commit> ""`, whose
empty old value means *create, and refuse if it exists*. Everything before it — `hash-object
--no-filters`, `mktree` level by level, `commit-tree` — writes objects no ref reaches, and an
object no ref reaches is garbage `git gc` collects. So nothing is rolled back, because nothing
a person can observe exists before the ref. `tests/invariants/forge.test.ts` holds that by
failing every git call of a submission, before it runs and after, over real repositories, and
by a stranger creating the branch before each of them.

Before that one write, `submit` checks, in this order: the value is one `clear.ts` minted
(`isCleared`, D3); it is for this forge's repository; `HEAD` is still the branch and commit
`base()` read; the base still holds, byte for byte, every file the gates judged
(`diverges`); the change changes something; the branch is under `idp-agent/` and its digest
is recomputed from the bytes; and a branch of that name is either absent, or exactly this
change — a branch and not a symbolic ref, one commit, on the base, these paths, these bytes,
these modes, the message the engine wrote (D7, D18). The one write is `--no-deref`, so a
symbolic ref never aims it at another name. A failure after the ref was created is told from
a stranger's ref by the commit it points at.

Opening the forge judges the arguments, once and before any model: a git working tree, at its
root; a `git` on `PATH`; an author and a committer identity git does not guess (D13). `base()` refuses a
detached or unborn `HEAD` as an argument error; the same, found at `submit`, is a refusal —
the repository moved during the run.

A refusal's `reason` and a `diverges` sentence name paths and branches the repository holds —
its own content, not ours — so `cli/` prints them through `inertLine`, as it does
`GitError.stderr`: a catalogue file committed with an escape sequence in its name is text to
show, never a command to the terminal.

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
