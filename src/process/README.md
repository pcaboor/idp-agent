# `process/` — the one place a process is started

A leaf of two launchers. `context/project-fs` reads a repository through the git launcher
(`git ls-files`), stage 8's discovery read (`context/discovery/read.ts`) asks it what a
repository tracks and what `HEAD` holds (`rev-parse`, `ls-files`, `ls-tree`, shapes it already
held), and the local forge (`forge/local/`) writes one through it (ADR-0010) — though no
command reaches the forge until `--submit`, and none reaches the discovery read yet. From
stage 6 the git launcher also holds the one push form, and the gh launcher the calls that read
GitHub's answers and open a pull request; no command starts gh yet. No importer may start a
process of its own: the launchers are shared so that every hardening line below applies to
every call or to none.

## What lives here

| file | what it is |
|---|---|
| `environment.ts` | `spawnedEnvironment` — a child's environment: the process's, without any `*_API_KEY` and without any `IDP_BACKSTAGE_*` variable, whatever their case — and `BACKSTAGE_TOKEN_VARIABLE`, the name it keeps out |
| `git.ts` | the git launcher: `gitIn` for every read and write, `pushIn` for the one push form, and `checkGitArgv`, the grammar both check their vector against; `gitEnvironment`, `pushEnvironment`, `HARDENING`, `PUSH_PINS`, `PUSH_FLAGS`, `PUSH_VARIABLES`, `GIT_LIMITS`, `PUSH_LIMITS`, `GITHUB_PUSH_URL`, `parsePorcelain`, `GitError` |
| `gh.ts` | the gh launcher: `ghIn`, which builds a vector from a typed request (`ghArgv`) and checks it (`checkGhArgv`) before handing it to `spawnGh` or a test's fake; `ghEnvironment`, `GH_REMOVED`, `GH_SET`, `GH_LIMITS`, `parseIncluded`, `GhError` |
| `grammar.ts` | the names both launchers hold an argument to: an object id, a submission's branch and ref (`SUBMISSION_BRANCH`, `SUBMISSION_REF`), a branch name (`isBranch`). It starts nothing |
| `refusal.ts` | `LauncherRefusal`: a vector outside a grammar — a programming error, never the user's — naming the command word and never an argument |

## The allow-list

Each launcher builds the argument vector, then checks the **finished** vector — the one
`execFile` is handed — against its grammar, before any process starts (stage 6 brief § 6).
Anything else throws `LauncherRefusal` and nothing starts; a caller's bug cannot pass a shape
the grammar does not know, because the check is on the vector, not on the request.

- **git** (`checkGitArgv`): `HARDENING`, `-C` and an absolute repository, then one of stage
  5's shapes exactly as the forge and the Inspector build them (`rev-parse`, `var`,
  `symbolic-ref`, `rev-list`, `diff-tree`, `cat-file`, `check-ref-format`,
  `hash-object -w --stdin --no-filters`, `mktree`, `commit-tree`, a create-only `update-ref`
  of a submission's ref, `ls-tree`, `ls-files`), the clone's configuration and remote read
  and never written (`config --list --show-scope -z`, `config --get branch.<b>.remote|merge`,
  `remote get-url [--push] --all -- <name>`), and `merge-base --is-ancestor`. Or the one push:
  `HARDENING`, `PUSH_PINS`, `-C` and the repository, `push`, `PUSH_FLAGS`, a
  `--force-with-lease=<ref>:` whose expected value is empty — create-only on the remote — one
  URL of `GITHUB_PUSH_URL`'s five forms, never a remote's name, and one refspec
  `<commit>:<ref>`, the ref a submission's and the lease's.
- **gh** (`checkGhArgv`): `--version`; `api --hostname github.com --method GET --include
  <path>`, the path one of ten templates — eight, and from Task 6.3.6 the two reads of what is
  in flight: `repos/<o>/<r>/pulls?state=open&base=<base>&sort=created&direction=desc&per_page=100&page=<p>`,
  `<p>` 1 to `IN_FLIGHT_PAGES` (3) and nothing else, and `repos/<o>/<r>/pulls/<n>/files?per_page=100`,
  each matched whole, so neither bends into a door — every value held to its grammar and encoded, and
  no `{`, `}` or `:` anywhere — gh's placeholders, `{owner}` and `:owner` alike, which gh
  fills from the current directory's repository; `api --hostname github.com --method POST
  --include repos/<o>/<r>/pulls --input -`, the one write, its body on stdin and exactly the
  JSON the engine writes: `title`, `head` (the bare submission branch), `base`, `body`,
  `draft: false`, `maintainer_can_modify: false`, in that order and with no white space, so
  no key is ever given twice.

No merge, approval, review, close, forced or mirroring push, deletion, `fetch`, `pull`,
`clone`, `gh pr …`, `gh auth …`, `gh repo …`, and no write method but the one `POST`. The
engine's own copy of these grammars will live in `core/github/` (stage 6's next step), because
this leaf imports nothing of ours, and a test will hold the two copies to one answer.

## What every call carries

Each line answers something that was measured, and `tests/unit/process-git.test.ts` plants
its reason in a real repository and proves the line holds:

- `spawnedEnvironment()` minus every `GIT_*` variable — no provider key and no catalogue
  token reaches git or anything git runs (ADR-0011); an inherited `GIT_DIR` cannot send
  `git -C <repo>` to another repository, `GIT_CONFIG_PARAMETERS` cannot undo the overrides,
  and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` cannot choose who commits;
- `-c core.hooksPath=/dev/null` — a repository's hooks are its owner's code, and they never
  run inside a call of ours;
- `-c core.fsmonitor=false`, `-c core.untrackedCache=false` — a configured fsmonitor is a
  command line, and `ls-files` runs it;
- `-c user.useConfigOnly=true` — git never guesses an identity from the login and host
  names: one is configured, or `commit-tree` refuses (D13);
- started from Node's own directory, never a repository's, which it reaches by `-C` and an
  absolute path — a `git` planted at a repository's root never runs;
- a timeout and an output cap (`GIT_LIMITS`), past which nothing is read;
- `execFile`, no shell.

## The three environments

| | every git call (`gitEnvironment`) | the push (`pushEnvironment`) | gh (`ghEnvironment`) |
|---|---|---|---|
| provider keys, `IDP_BACKSTAGE_*` | removed | removed | removed |
| `GIT_*` | removed | removed but `PUSH_VARIABLES`: `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `GIT_ASKPASS` — the person's way of reaching GitHub | removed |
| `GH_HOST`, `GH_REPO`, gh's and Go's debugging, forced terminal formatting, the Enterprise tokens (`GH_REMOVED`) | kept | kept | removed |
| set | `LC_ALL=C`, `LANGUAGE=C`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` | the same | `GH_SET`: no prompt, no update notice, no spinner, no colour, `GH_PAGER=cat` |

Everything else passes, as it would to the person's own git and gh: their ssh-agent, `HOME`,
proxy and CA variables, and gh's own login, which idp-agent never reads (§ 5). The push has
its own bounds (`PUSH_LIMITS`), since ssh may ask for a key's passphrase.

What this does not do is sandbox git or gh: the user's global configuration is read, because
their identity and their way of pushing live there.

## What may not

Nothing here imports anything of ours, nor any package: `node:` built-ins and each other
only, because anything this leaf imported would be reachable from every one of its importers.
`tests/architecture/dependencies.test.ts` holds that (*process/ imports nothing of ours, and
only node: built-ins*), holds `git.ts` and `gh.ts` to being the only modules importing
`child_process` (*only the named modules write, and only process/git.ts and process/gh.ts
start a process*), holds each of their calls — `gitIn`'s, `pushIn`'s, `spawnGh`'s — to an
environment that starts from `spawnedEnvironment` and names what it is handed nowhere else
(*every process src/ starts is given spawnedEnvironment*), keeps every door and every
GitHub credential's name out of the source (*nothing in src/ names a door the allow-list
refuses*, *nothing in src/ reads a GitHub credential from the environment*), and holds the
git launcher's importers to the three above (*only context/project-fs,
context/discovery/read.ts and forge/ load the git launcher*): `gitIn` runs git in any
repository, so a module outside those three would go around project-fs's secret exclusions
and the discovery read's lists of what it never opens. A type may be named anywhere; `environment.ts`,
`grammar.ts` and `refusal.ts` start nothing and may be imported by anyone. `core/` may not
import this folder, directly or through anything else.
