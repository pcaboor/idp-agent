# Submitting to GitHub

What a person needs before idpa can open a pull request on their behalf, and how to check it.
Stage 6 builds the submission itself task by task ([`plans/stage-6-github.md`](plans/stage-6-github.md));
what works today is `idpa protection`, the check a submission will make before it writes anything.
The design is [`stage-6-brief.md`](stage-6-brief.md), § 5 to § 8.

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
