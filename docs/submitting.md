# Submitting to GitHub

What a person needs before idpa can open a pull request on their behalf, and how to check it.
Stage 6 builds the submission itself task by task ([`plans/stage-6-github.md`](plans/stage-6-github.md));
what works today is `idpa protection`, the check every submission makes before it writes anything,
and [`plan --from … --submit`](#submitting-a-plan-file), which pushes and opens the pull request.
The design is [`stage-6-brief.md`](stage-6-brief.md), § 3 to § 15.

## What you need

- **Your own git, able to push to the repository** as it already does: your SSH key and agent, or
  your credential helper, from your global configuration. idpa never reads either.
- **gh, at least 2.40.0** (`GH_MINIMUM_VERSION`, provisional until the live run pins it), logged in
  to github.com **as yourself**:

  ```bash
  gh auth login --hostname github.com
  gh auth status --hostname github.com
  ```

  A bot, an app's token or a workflow's token is refused: the pull request's author would be a bot,
  and the person who asked could approve it.
- **No token for idpa.** It has no token variable, no flag and no configuration key for one. gh reads
  its own login — its stored one, or `GH_TOKEN` if you export it — and idpa passes your environment
  to gh unread, minus the variables that would point gh at another host.

## The ruleset on the base branch

A pull request is opened only into a branch whose rules keep it from merging until someone other
than its opener approves its latest commit. On GitHub that is a **ruleset**; classic branch
protection is not read, and a base protected only by it is refused.

On the repository's page: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**, then

1. a name, `idpa` for instance, and enforcement **Active**;
2. the bypass list left **empty**;
3. target branches: **Include default branch** (or the branch you submit into);
4. tick **Restrict deletions**;
5. tick **Require a pull request before merging**, with **1** required approval and **Require
   approval of the most recent reviewable push**;
6. tick **Block force pushes**;
7. **Create**.

That is the list `idpa protection` checks, `init platform` prints and a refused submission will
print (`PROTECTION_SETTINGS`):

```text
  required · require a pull request before merging — 1 approval
  required · require approval of the most recent reviewable push (or dismiss stale approvals when new commits are pushed)
  required · block force pushes; restrict deletions
  required · nobody who submits in the bypass list
  advised  · no deploy key and no app in the bypass list
  advised  · GitHub Actions may not approve pull requests (Settings → Actions → General → Workflow permissions)
  advised  · set it at the organisation level, where a repository administrator cannot change it
  advised  · require review from Code Owners
  advised  · the downstream decision as a required status check, once one reports (ADR-0012)
```

Prefer *approval of the most recent reviewable push* to *dismiss stale approvals*: with only the
second, the account your git pushes with could approve a pull request your gh opened. Also
advised, though not checked: a second ruleset on `refs/heads/idp-agent/**` blocking force pushes
and deletions, so a branch under review is never rewritten.

## `idpa protection`

```bash
idpa protection --repo ~/my-iac
```

It reads the branch the clone's checked-out branch tracks on github.com, through your gh, with
`GET` requests only: who gh acts as (`GET user`), the repository, the rules for that branch, each
ruleset that supplies one of the required rules, and — only when none does — the branch, for
classic protection. Before them it runs `gh --version`, which stays on your machine. No model, and
nothing written, in the clone or on GitHub. Without `--repo` it finds the declarations repository
as `plan` does: the current directory when it is one, then `IDP_REPO`, then `repo` in your personal
`config.yml`.

| Exit | When |
|---|---|
| `0` | the rules hold: a pull request rule of at least 1 approval, approval of the most recent push (or stale approvals dismissed), no force push, no deletion, from rulesets gh's account cannot bypass (`current_user_can_bypass: never`), and no deploy key in a bypass list gh can read |
| `1` | they do not — or the repository is archived, renamed, or yours to read but not to push — and it prints what is missing and the ruleset to add; or GitHub failed to answer, in one sentence of idpa's |
| `2` | the arguments, the clone or gh are refused: not a clone's root, a detached `HEAD`, a branch that tracks no remote or a remote on another host, a key of the clone's own configuration (below), gh missing, logged out, too old or not a person |

When the rules hold it also reports what is not required — review from Code Owners, the required
status checks, signed commits, a merge queue — and says what **no read can see**:

- an administrator can edit or disable the ruleset outside idpa, and then merge; GitHub records it
  in the ruleset's history;
- the credential your git pushes with: `current_user_can_bypass` answers for gh's account only,
  and a deploy key or another account's key in the bypass list could move the base without a pull
  request. idpa refuses a deploy key it can see; the bypass list is shown only to someone who may
  edit the ruleset;
- whether GitHub Actions or an app may approve pull requests in the repository.

## Submitting a plan file

The invariant every submission keeps: the identity that opens a pull request cannot merge it until
someone else has approved the exact commit that would merge, and idpa never submits against a base
without those rules.

```bash
idpa plan --from examples/open-network.json --repo ~/my-iac --submit
```

In a clone whose checked-out branch tracks a branch on github.com, it runs in this order, and each
step can end the run with nothing written:

1. **The road and gh**, before anything is read: the branch's upstream, both URLs of its remote,
   the clone's own configuration ([below](#the-clones-own-configuration)), then gh's version and
   who it is logged in as. On stderr: `submitting to github.com/acme/iac, into main (origin,
   main's upstream), as ada (gh)`.
2. **The base**, before anything is previewed: the ruleset, as `idpa protection` reads it, and
   whether GitHub's base is the commit your clone's is.
3. **The diff**, and one question:

   ```text
   Push idp-agent/orders-api-to-payments-e9e6183f to github.com/acme/iac with your git, and open a pull request into main with your gh? Nothing is provisioned until someone else approves it and it is merged. [y/N]
   ```

   A script, a pipe or `--json` has `--submit` as its answer: the question was never the guard,
   the ruleset is.
4. **At the moment of acting**, the road, the clone's configuration, the rules and the base's tip
   are read again; then the branch is cut in the clone, your git pushes that very commit to the
   same name, create-only (a branch already there is never moved), gh reads it back, the rules are
   read once more, and your gh opens one pull request whose body the engine writes.

It ends on the pull request, at a URL the engine builds from the repository and the number, and on
what merging it waits for:

```text
1 file · submitted as idp-agent/orders-api-to-payments-e9e6183f on top of main@3f9c2a1 · main untouched
Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1
Merging it waits for one approval of its latest commit from someone other than you. No status check is required, so a system downstream could not refuse it (ADR-0012).
Nothing is provisioned yet. The merge is what authorises it.
```

**Run it again** and it asks nothing and writes nothing: `1 file · already submitted as
idp-agent/… · pull request #1 is open · nothing written`. A pull request on an older base is named
too, and says GitHub shows whether it still merges cleanly.

**When it stops halfway.** The two systems are not one transaction, and every state between them is
completed by running the same command again. A push that failed leaves the branch in the clone and
says so (`… was cut in this clone, and no pull request was opened.`, exit 1). A branch pushed whose
pull request was not opened says why — `<branch> is on github.com/acme/iac, and the pull request was
not opened: GitHub answered 502 through gh. Run the same command again to open it.` — and the next
run asks only `Open a pull request from … into main on github.com/acme/iac with your gh? The branch
was pushed by an earlier run.` and opens it.

**A closed pull request** is not reopened, nor a merged one that was since reverted: the run says
which, exit 1. Reopen it on GitHub, or change the request.

**`--local`** cuts the branch in the clone only, reads nothing on GitHub and starts no gh; it ends on
`--local: nothing pushed by this run`. A clone whose branch tracks nothing ends on `main tracks no
remote: nothing pushed`, whatever the branch is named, and one whose remote is on another host on `the remote is on <host>, where
this build opens no pull request: nothing pushed`. `--local` without `--submit` is refused (exit 2).

Each refusal, and its one fix:

| Refused | Exit | Fix |
|---|---|---|
| gh not installed, logged out or expired, older than 2.40.0, or logged in as a bot or an app | 2 | `gh auth login --hostname github.com` as yourself, or update gh; or `--local` |
| a key of the clone's own configuration | 2 | move it to your global configuration ([below](#the-clones-own-configuration)) |
| a remote URL carrying a credential, or one that does not parse | 2 | `git remote set-url origin https://github.com/<owner>/<name>` |
| a checked-out branch that tracks one, named with a `%`, `{`, `}` or invisible character | 2 | `git branch -m <name>`; or `--local` |
| a base whose rules would let you merge unreviewed | 1 | add the ruleset it prints ([above](#the-ruleset-on-the-base-branch)) |
| a clone not level with GitHub | 1 | `git pull`, then run it again; a change already submitted is then named |
| the rules gone, the base moved, or the clone's configuration changed, between the question and the push | 1 | nothing was written; run it again once they hold |

`plan "<intent>" --submit`, `init --submit` and `idpa "<phrase>" --submit` follow in stage 6's next
tasks. Until then, toward GitHub, `plan "<intent>" --submit` and `init --submit` are refused before
any model and before gh (exit 2), naming `--local`; `idpa "<phrase>"` does not submit.

## Push as gh's account

Nothing idpa can read ties the account your git pushes with to the one gh opens pull requests as.
Make them the same:

- over HTTPS, `gh auth setup-git` makes gh's login git's credential for github.com;
- over SSH, use a key of the same account — never a deploy key.

## The clone's own configuration

A clone's `.git/config` is the one file on your machine someone else may have written, and git
reads it on every call. So a key that would choose where a push goes, who authenticates it or what
program runs during it is refused when it is set in the clone — the `local` or `worktree` scope —
and idpa names the key and its scope, never its value. Your global and system configuration are
yours, as for your own `git push`.

- Refused whole sections: `url`, `credential`, `http`, `protocol`, `ssh`, `gpg`, `push`.
- Refused keys: `core.sshCommand`, `core.askPass`, `core.gitProxy`, and for any remote
  `remote.<name>.vcs`, `.receivepack`, `.uploadpack`, `.proxy`, `.proxyAuthMethod`.
- Kept, being harmless: `http.postBuffer`, `http.lowSpeedLimit`, `http.lowSpeedTime`,
  `push.default`, `push.autoSetupRemote`, `gpg.format`.

A common one to move is a credential helper set in the clone:

```bash
git config --local --unset-all credential.helper
git config --global credential.helper osxkeychain
```

(`osxkeychain` on macOS; the helper you already use elsewhere.) Then run the command again.
