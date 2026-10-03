# ADR-0015 — a submission is a pull request, and the base's rules decide who may merge it

**Date** 2026-10-02 · **Status** accepted, 2026-10-03 · **Builds on** ADR-0006, ADR-0010,
ADR-0011, ADR-0012

*Accepted by the owner, the decision being theirs at each step and already the one below: on
2026-09-30, no GitHub credential in idpa — the person's own git pushes and their own gh reads
and opens, "like Claude Code" — and a bot or an app's token refused; on 2026-10-01, the pull
request always opened, with a neutral note where its author may merge it alone, the invariant
reworded in design §4.2 word for word as it stands below, the engine's proposal at a terminal,
what is in flight read first, and the second account of the live test made optional. The live
test was run on 2026-10-02 without it.*

## Context

Stage 5 cut a local branch, `idp-agent/<slug>-<8 hex>`, create-only (ADR-0010), and ended on
"Nothing is pushed. No merge request is opened: this build has no forge (stage 6)". ADR-0006
had promised a forge "whose token may open a request, never merge it", and design §9.4 a test
named after that token.

No stage-5 document stated the fact that undoes it: **on GitHub, the right to push a branch is
the right that merges.** A classic token's `repo` scope, an SSH key and a fine-grained token's
*Contents: write* each push a branch and each merge a pull request; no credential can be scoped
out of merging. "One token per capability", stage 5's sentence, cannot be delivered by any
credential's scope, and this record, ADR-0015, replaces it. What can refuse a merge is the base
branch's ruleset, which binds whoever holds the credential.

The owner decided on 2026-09-30 that idpa holds no GitHub credential at all, "like Claude
Code": the person's own git pushes, with whatever key or credential helper they already use,
and the person's own gh reads the rules and opens the pull request
([the stage 6 note](../stage-6-brief.md), § 5 and § 18). On 2026-10-01 the owner changed what
the rules decide: "you can merge your own pull request if you have the role on GitHub or
GitLab; it all depends on the company's rules". So the pull request is **always opened**, and
where the rules let its author merge it alone, the run says so rather than refusing
(`docs/roadmap.md`, *Decisions*, 2026-10-01). The same day the owner added two more: at a
terminal, the engine proposes to open the pull request after the diff, and what is already in
flight is read first.

## Decision

**idpa never merges and never writes to the base: it opens a pull request, and the base's
rules decide who may merge it.** Whether its author may merge it alone is the company's rule,
not this tool's; where the rules allow it, idpa says so — `note: on this repository the author
may merge without another person's review` — on stderr and in the pull request, and the pull
request is opened all the same. Where the rules require someone else's approval of the exact
commit that would merge, the identity that opens the pull request cannot merge it.

**The person's git pushes the exact commit, create-only.** The local forge cuts the commit as
ADR-0010 says; `process/git.ts`'s one push form sends that commit, never a name to resolve, to
one ref under `refs/heads/idp-agent/`, with `--force-with-lease=<ref>:` and an empty expected
value, so a ref that exists refuses the push rather than being moved. One refspec, to the URL
`git remote get-url --push` printed — never a remote's name — with hooks off, no tags, no
submodules, no signature and the `ext` and `file` transports pinned off on the command line.
The pushed ref is read back through gh, at most three reads over two seconds, before anything
is opened.

**The person's gh reads and opens.** Ten `GET` templates — who gh is, the repository, the
branch, the rules for the base, a ruleset, a ref, a commit, the pull requests from a branch,
and, from 6.3.6, the open pull requests into the base and one pull request's files — and one
`POST` that opens the pull request, every call with `--hostname github.com`, the body on
standard input and built by the engine. The pull request's URL is built by the engine from the
parsed host, owner, repository and number, never GitHub's `html_url`.

**Both launchers check the final argument vector against a grammar** before any process
starts, and throw `LauncherRefusal` otherwise: git's is stage 5's shapes, three reads and the
one push form; gh's is `--version`, the ten reads and the one `POST`. No merge, approval,
review, comment, close, reopen, label, forced push, deletion, push outside `idp-agent/`,
`PUT`, `PATCH`, `DELETE` or GraphQL. Four architecture rules hold the source to it: only
`process/git.ts` and `process/gh.ts` start a process, no source names a door the grammars
refuse, no source reads a GitHub credential from the environment, and only `forge/github/`
loads the gh launcher. `ForgeProvider` has no `merge`, `approve`, `close` or `delete`, and no
way to name a branch.

**idpa reads, stores and sends no GitHub credential.** The person's environment reaches git and
gh unread, minus what the note's § 5 removes — every provider key and catalogue variable, every
`GIT_*` but the four the push keeps, the person's way of reaching GitHub, and for gh the
variables that would point it at another host or log its traffic. No credential is in an
argument, standard input, stdout, stderr, a trace, a pull request body or a model request.

**The repository's own configuration is hostile; the person's global and system
configuration is theirs.** A key at the `local` or `worktree` scope that would choose where a
push goes, who authenticates it or what program runs during it is refused, exit 2, naming the
key and its scope, never its value, before any model; found at the moment of acting, the same
refusal is exit 1, nothing written.

**The repository is read once, before any model; the base's rules before anything is written,
and again at the moment of acting.** Through gh, `GET` only: the repository (item 1: answering,
not archived, under the name the remote gives, `permissions.push`), read in the preflight alone
— a repository that failed it never reaches a submission — then the rules for the base (a pull
request rule of one approval with approval of the most recent push or dismissal of stale
approvals, no force push, no deletion), and each supplying ruleset's `current_user_can_bypass`,
of which only `never` counts; classic protection alone does not count, and a deploy key visible
in a bypass list is said. **Item 1 refuses the push itself**, exit 1, nothing written. **The
rest decide the note, never whether to open**: missing, bypassable or classic-only rules are
said on stderr before any model and in the pull request's body, and the submission exits 0. The
rules are read again before the local ref is cut, and once more after the read-back, for the
note in the body.

**Without gh, or with gh logged out, expired, too old or not a person, nothing is pushed**,
exit 2, `--local` named: idpa cannot read the rules, so it does not publish a branch against
them. A bot or an app's token is not a person, since the person who asked could then approve
their own request.

**Recognition comes before anyone is asked.** The same bytes on the same base name the same
branch: GitHub's ref, its commit and the pull requests from it are read, and a submission
already made — on this base, or as our one commit on an older base with its pull request open
— is named, exit 0, nothing written. A closed or reverted pull request is refused, never
reopened. **What is in flight is read first**, on every `--submit` road before any model and
again at the moment of writing: the open idp-agent pull requests into the base and their
files. The same bytes another person proposed are named, exit 0; a different change to a file
this change writes is refused, exit 1, its patch on stderr; a change to other files of the same
entities is opened beside it, its body naming the other by number. Another person's pull
request is never edited, commented on, closed or cross-referenced.

**At a terminal, the engine proposes.** A change previewed without `--submit` — a phrase the
Supervisor calls a change, or `plan "<intent>"` — ends on `--submit`'s own question, byte for
byte, once the engine has read, after the last model call, what `--submit` reads. The person's
`y` authorises; no model writes the question and no agent holds a tool that pushes. Where the
engine could not do what the question says, one `no pull request proposed — …` line says why
and the preview stands at exit 0. A run with no terminal still needs `--submit`.

**Two systems, each atomic on its own, never claimed atomic together.** Locally, ADR-0010's
create-only ref; on GitHub, one ref per push, created or not. Every state between them is
completed by running the same command again:

| After a failure at | What exists | What the next run does |
|---|---|---|
| the re-check at the moment of acting (rules, base, configuration, what is in flight) | nothing, on either side | refuses or proceeds on what it reads then |
| the local branch | nothing, or the whole local branch | stage 5's recognition, then on to GitHub |
| the push, refused or interrupted | the local branch; on GitHub nothing, or the ref if the push landed and its answer was lost | pushes again; a ref that landed is recognised by its commit |
| the read-back | the local branch; the pushed ref somewhere else, or another commit at the name | refuses until the push reaches github.com, or meets a branch that is not ours |
| the pull request not opened | the local branch; the branch on GitHub, no pull request | recognises the branch as ours and asks only to open the pull request |
| after the pull request | everything | "already submitted", naming the pull request |

## How it is proved

Twice. **Offline, in `pnpm test`**, against the fake gh and a bare remote reached through a
fake ssh, with the suite owning every variable that could carry a child process to GitHub
(`tests/setup/forge.ts`): `tests/unit/merge-refused.test.ts` tries every door as the identity
that opened the pull request and finds each refused and `main` unmoved, refuses the author's
merge after a push on top of an approved head, and opens the pull request with the note
wherever the rules let its author merge alone; `tests/invariants/github-forge.test.ts` fails
every git, push and gh call in turn and finds a row of the table above after each, opens the
pull request on every shape of rules with the note exactly where the rules do not hold, and
never writes another person's pull request; `tests/unit/launcher-doors.test.ts` refuses each
door before a process starts.

**Live, by the owner**, by hand and never in CI, on a public throwaway repository with their
own gh session and, optionally, a second account's for the steps only another person can take
(`tests/live/github/submit.live.test.ts`, `pnpm test:live:github`). Its recorded answers,
logins removed (`tests/contract/github/answers-2026-10-02.json`), hold the fake to what GitHub
answered, offline, from then on (`tests/contract/github-answers.test.ts`). The run of
2026-10-02, on the owner's `idpa-live` repository, passed, and measured:

- the gh version of the run, which is the oldest this build accepts: gh 2.96.0
  (`GH_MINIMUM_VERSION`), with git 2.46.0;
- the administrator's bound: for the repository's administrator, the ruleset's bypass list
  empty, `current_user_can_bypass` answered `never` — the note's § 17, first unknown, answered
  — and `gh pr merge --admin` was refused by the rule;
- each door's answer, as the identity that opened the pull request, fourteen in all and the
  base's commit unchanged after each: `gh pr merge` by merge, squash and rebase, and with
  `--admin`, refused by the rule; the REST merge, 405; `merge-async`, 202 Accepted and never
  carried out — the pull request watched 30 seconds, never merged, and still unmerged at the
  end of the run; `POST merges`, 409; a `contents` write on the base, 409; a non-forced update
  of the base's ref, 422; a non-forced push onto the base, rejected by the rule (`GH013:
  Repository rule violations found`, "New changes require approval from someone other than
  the last pusher"); GraphQL's `mergePullRequest` and `createCommitOnBranch`, refused by the
  rule; the author's own approval, through gh and through REST (422), refused;
- after another account's approval and a push on top of it, the opener's merge: **not tried
  live** — the second account was not used, so this step, and the same change proposed by
  another person, rest on the fake (`tests/unit/merge-refused.test.ts`) and on the rule's read
  (approval of the most recent push, read in every check), not on GitHub's answer;
- the read-back: one read, no lag seen — GitHub held the pushed branch on the first;
- an `@mention` inside the request's fenced block: rendered as code, with no mention link;
- on a base no ruleset covers, the pull request opened with the note, on stderr and in its
  body;
- the pull request's body: no token shape in it (`tokenShapeInBody: false`);
- three fields the owner filled by hand, true of `idpa-live` only and of no company's
  repository: GitHub Actions may not approve pull requests there, the owner's git pushes as gh's
  account, and the ruleset's bypass list is empty.

## Rejected alternatives

- **A dedicated fine-grained token and idpa's own REST transport** (the note's first draft):
  one more secret per person to create, scope, rotate and leak, for a guarantee that rested on
  the ruleset anyway, since *Contents: write* merges as surely as `repo` does. It would have
  kept the token in one Node closure, behind typed routes.
- **Refusing to submit where the rules let the author merge alone** (the decision of
  2026-09-30, replaced on 2026-10-01): it made the company's rule this tool's.
- **Pushing without gh and printing a compare URL, or a `--no-pr` flag**: a branch published
  against rules idpa never read.
- **`gh pr create`**: it may push, fork, prompt and read the current directory's remotes; one
  `POST` whose body the engine builds is far narrower.
- **Pushing to the remote by name**: it consults the remote's refspecs, mirror, `receivepack`
  and proxy. **A plain push without the lease**: it fast-forwards an existing `idp-agent/` ref.
- **`GIT_CONFIG_NOSYSTEM` or a private `GIT_CONFIG_GLOBAL` for the push**: each drops the
  person's own credential configuration, and neither removes the repository's.
- **Reading gh's token to call GitHub from Node**: a GitHub secret in idpa.
- **A merge probe in the CLI, or merging on confirmation**: a merge call in the tool's code,
  which ADR-0006 refused and GitHub's permission model does not change.
- **Reading `mergeable_state`**, or **refusing administrators through `permissions.admin`**:
  the first is asynchronous and answers another question; the second refuses an administrator
  the ruleset binds and passes a non-administrator in its bypass list.
- **Accepting classic branch protection as rules that hold**: its settings need administration
  rights to read.
- **Covering the base in the branch's digest**: every merge on `main` would rename a change
  under review and open its duplicate.
- **A fork workflow**, **a GitHub App in v0.1**: the first gains nothing for a person who can
  push to the base; the second makes the bot the author, so the requester could approve.
- **Trusting GitHub's `html_url`, gh's or git's output**: text idpa did not write.
- **Reopening a closed pull request, or pushing onto an existing branch**: both move what a
  reviewer has seen; a changed request is a new branch.
- **Running the live test in CI**: a logged-in gh in CI is a credential someone else's
  workflow can reach. **A forced update of `main` in it**: a wrong success would rewrite
  history.
- **Editing, commenting on or closing another person's pull request in flight**: a write to a
  request nobody here authored.

## Consequences

**What no read can see**, stated in `SECURITY.md` — the first, the fourth and the fifth printed
by `idpa protection` too — none made into a guess: an administrator can edit or disable the
ruleset outside idpa and then merge, which GitHub's ruleset history records; a classic rule's
settings are invisible; the account git pushes with and the account gh opens with may be two,
and nothing idpa reads ties them; the push credential's bypass cannot be read, so a deploy key
or another account's key in the bypass list could move the base without a pull request; and an
approval by a workflow or an app counts as someone else's.

So the invariant has a limit, worded once: where the rules require another person's approval,
it **binds the identity that opens the pull request and every credential that person pushes
with**, as long as the ruleset stands, the push credential is not in its bypass list, and no
workflow or app approves in someone else's place. The push credential is not proven to be gh's
account in stage 6 (the note's § 19, Q4); `docs/submitting.md` recommends `gh auth setup-git`
over HTTPS and a key of the same account over SSH.

**A known limit, not fixed in stage 6.** GitHub answers `protected: true` on the branch route
for a branch a ruleset covers, with no classic protection set (measured on 2026-10-02), and the
preflight reads that route only when no ruleset supplies a required rule. So a base covered by
a ruleset that supplies none of the three required rules is reported by `idpa protection` as
"protected by classic branch protection only": the exit, 1, and a submission's note are right;
the reason is wrong — the missing rules go unnamed, and the person is told to add a ruleset
that exists. Its fix is a follow-up after stage 6 (`docs/roadmap.md`, *Open questions*).

Stage 6 is a laptop tool, not a CI step (Q1): gh must be logged in as a person, and a
server-side runner needs an ADR of its own. github.com only; GitHub Enterprise comes later,
through gh's own host configuration, with a real instance to test against (decision 16).
ADR-0012 stays proposed: stage 6 reads and prints the required status checks and requires
none. D6 (a plan writing into both repositories) and D12 (`init --submit` for a service in a
subfolder of its repository) stay refused. ADR-0006's token sentence is replaced by the
invariant above; its decision — the merge is the act of authorisation — stands.
