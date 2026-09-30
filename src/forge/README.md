# `forge/` — where a submission becomes a branch

The layer that writes into a user's repository: one new ref under `refs/heads/idp-agent/`,
cut through git's plumbing, and nothing else (ADR-0010). It holds its shapes, its refusals and
the local forge; `plan … --submit`, on either road, and `init --submit`, for the service's own
repository, reach it, through `cli/commands/submit.ts`; `idpa protection` reaches its GitHub
half, which only reads, through `cli/commands/protection.ts`. The GitHub forge, which pushes
that branch and opens one pull request, is built and tested offline; no command reaches it
yet (stage 6 plan, 6.2.2 wires it).

## What lives here

| file | what it is |
|---|---|
| `provider.ts` | `ForgeProvider` (`name: 'local' \| 'github'`, and no `merge`, `approve`, `close` or `delete`), `Base`, `Submitted` and `Recognised` — on GitHub also `pushed`, `pullRequest`, `olderBase`, `statusChecks`, a refusal's `kept`, and `pushed-without-pull-request` and `closed` — `PullRequest`, the road a submission takes (`Road`, `GitHubRoad`, `LocalRoad`) and who gh is (`GhIdentity`) — **types only**, like `llm/client.ts` |
| `errors.ts` | `ForgeInputError` — the refusals that are the user's arguments, exit 2 |
| `local/objects.ts` | `blobId`, `treeId`, `objectFormat`, `treeOf`, `writeTree` — reading and writing git objects, never a ref; `buildTree`, the one walk `writeTree` and `treeFor` share |
| `local/tree.ts` | `treeFor(git, parent, edits, format)` — the tree a change would have on `parent`, computed and never written: what the GitHub forge compares a commit this clone never made with (stage 6 brief § 4, § 14) |
| `local/forge.ts` | `openLocalForge(repo, repository, git?, { acceptOlderBase? })` — `base`, `diverges`, `recognise`, `submit`, over a clone on this machine; `acceptOlderBase`, the GitHub forge's alone, takes our one commit on an ancestor of the base as ours on an older base |
| `github/` | stage 6's GitHub half: `readRoad`, `readIdentity`, `githubApi`, `readProtection`, `readRules`, `openGitHub`, which `idpa protection` reaches, and `github/forge.ts`, the GitHub forge — [its README](github/README.md) |

## How a submission is atomic

A submission becomes visible at exactly one point: `update-ref <ref> <commit> ""`, whose
empty old value means *create, and refuse if it exists*. Everything before it — `hash-object
--no-filters`, `mktree` level by level, `commit-tree` — writes objects no ref reaches, and an
object no ref reaches is garbage `git gc` collects. So nothing is rolled back, because nothing
a person can observe exists before the ref. `tests/invariants/forge.test.ts` holds that by
failing every git call of a submission, before it runs and after, over real repositories, and
by a stranger creating the branch before each of them.

The GitHub forge adds a second system, and the two together are not atomic: its only writes on
GitHub are one ref, created by a push whose lease says it must not exist, and one pull request,
each atomic on its own. Every state a failure leaves between them is a row of the stage 6
brief's § 4 table that the same command, run again, completes;
`tests/invariants/github-forge.test.ts` fails every git, push and gh call of a submission in
turn, both ways, and runs it again.

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

`ForgeProvider` has four methods — `base`, `diverges`, `recognise`, `submit` — one of which
writes, and the absences are the design (`tests/unit/forge-types.test.ts` holds them, on both
forges, with `@ts-expect-error`). `recognise` is `submit`'s own test of a branch
already there, run before anyone is asked to confirm, and it only reads. There is no `merge`: the merge is the act of authorisation (ADR-0006), and a method
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
through `process/git.ts`, which it is one of two to load, and every gh call through
`process/gh.ts`, which only `github/` loads. Only `cli/` reaches it at run
time, however many hops away — a module that imports a `cli/` module importing the forge
reaches it too; another layer may name its types with `import type`, which is erased. `core/` may not import
it at all — `Cleared` is core's, so that would be a cycle. The rules are in
`tests/architecture/dependencies.test.ts`: *forge/ imports core/, process/, node:crypto and
node:path, and nothing else*, *only cli/ reaches forge/ at runtime*, *only context/project-fs
and forge/ load the git launcher*, *only forge/github/ loads the gh launcher*, and *core/ imports nothing from
context/, cli/, scaffold/, forge/ or process/*.
