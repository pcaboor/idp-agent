# Example plans

Each file is a `Plan` — the JSON an Architect would produce. `plan --from` reads
one, signs it, runs the policies, re-checks it against the repository, and shows
the diff it would produce. No model is involved and none can be, so none of this
needs a key. It writes nothing, ever.

```bash
# against the fictional demo SI shipped in fixtures/si-demo
node dist/cli/bin.js plan --from examples/declare-cache.json --repo fixtures/si-demo

# against a declarations repository of your own, freshly scaffolded
node dist/cli/bin.js init platform /tmp/my-iac --owner @acme/platform
node dist/cli/bin.js plan --from examples/declare-database.json --repo /tmp/my-iac
```

`plan --from` takes no `--demo`: a preview is decided against a declarations
repository — `--repo`, or the one found as every command finds it — so the demo
SI is named by its folder.

What each file does run outside a terminal — piped, in CI, or as `pnpm smoke`
runs it. `pnpm smoke` reads this table and runs every row against both
repositories, so an exit code or an outcome written here that the binary does not
produce fails the build, and so does a file in this folder with no row.

| file | what it shows | fresh `init platform` repository | demo SI (`fixtures/si-demo`) |
|---|---|---|---|
| `declare-cache.json` | a cache every value of which is vouched for: the request names it, its environment and its owner, and the demo SI declares what it depends on | 0 · diff | 0 · diff |
| `declare-database.json` | a database every value of which is vouched for | 0 · diff | 0 · nothing to change |
| `add-access.json` | a database and a read grant on it: the level of a grant is always asked, never read out of the request | 3 · question | 3 · question |
| `needs-an-owner.json` | an owner nobody can vouch for, asked about rather than guessed | 3 · question | 3 · question |
| `unvouched-name.json` | a name carrying a segment (`prod`) the request never mentioned | 3 · question | 1 · refused |

The outcomes, as the binary prints them:

- **diff** — the unified diff, then `1 file · nothing written`. On the fresh
  repository `declare-cache.json` also warns that `redis-shared-dev`, which the
  cache depends on, is declared nowhere there: a dangling reference is reported,
  never pruned.
- **nothing to change** — the demo SI already declares `orders-db-prod`, so the
  run names the file that does, prints no diff, and exits 0.
- **question** — `1 question, asked rather than guessed:`, the field and what
  the draft said, and nothing previewed.
- **refused** — on the demo SI the name `orders-db-prod` is already witnessed,
  so it is no longer the question; the `environment-mismatch` policy refuses the
  plan instead, because the request named `dev` and the plan touches `prod`.

**In a terminal the question is asked at a prompt** rather than printed: answer
it and the run carries on to the diff. `add-access.json` answered `read` shows
the grant it would declare. A non-interactive run has nobody to ask, so it
prints the question and exits 3.

**On the order of the gates.** The signature runs before the policies, and it is
strict: on a freshly scaffolded repository nothing is witnessed yet, so almost
any invented value becomes a question before a policy ever sees it. The policies
earn their place against a repository that already holds entities — which is
why `unvouched-name.json` is a question on one repository and a refusal on the
other.

**On the one question a grant always carries.** `spec.access` is `read` or
`readwrite`, and the signature will not take it from the request: `echoes` is a
word test, and a level is a common word — *"do not grant readwrite, only read"*
made `readwrite` look asked for, and *"the read replica of orders-db"* named a
level nobody asked for. So a level is answered at a prompt or it is a question,
which costs one prompt per grant and closes the gap between a request for read
and a grant of write.
