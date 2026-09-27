# Example plans

Each file is a `Plan` — the JSON an Architect would produce. `plan --from` reads
one, signs it, runs the policies, re-checks it against the repository, and shows
the diff it would produce. No model is involved and none can be, so none of this
needs a key. It writes nothing, ever.

```bash
# against the fictional demo SI shipped in fixtures/si-demo
node dist/cli/bin.js plan --from examples/open-network.json --repo fixtures/si-demo

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
| `open-network.json` | a network flow whose environment comes from the declaration the request points at: it names `resource:default/payments-api` by its reference in full, and the demo SI declares it prod | 3 · question | 0 · diff |
| `declare-cache.json` | a cache whose environment the request names only in words, which is asked | 3 · question | 3 · question |
| `declare-database.json` | a database whose environment the request names only in words, which is asked | 3 · question | 3 · question |
| `add-access.json` | a database and a read grant on it: the level of a grant is always asked, and so is an environment nobody pointed at | 3 · question | 3 · question |
| `needs-an-owner.json` | an owner nobody can vouch for, asked about rather than guessed | 3 · question | 3 · question |
| `unvouched-name.json` | a name carrying a segment (`prod`) the request never mentioned | 3 · question | 3 · question |

The outcomes, as the binary prints them:

- **diff** — the unified diff, then `1 file · nothing written`.
- **question** — `1 question, asked rather than guessed:` (or more), each
  field and what the draft said, and nothing previewed. On the fresh
  repository `open-network.json` is one: nothing is declared there, so the
  request points at nothing and its environment is asked.

**In a terminal the question is asked at a prompt** rather than printed: answer
it and the run carries on to the diff. `add-access.json` answered `read`, and
`prod` for each environment, shows the grant it would declare. A
non-interactive run has nobody to ask, so it prints the question and exits 3.

**On the order of the gates.** The signature runs before the policies, and it is
strict: on a freshly scaffolded repository nothing is witnessed yet, so almost
any invented value becomes a question before a policy ever sees it. The policies
earn their place against a repository that already holds entities — which is
why `unvouched-name.json` asks about its name on the fresh repository, where
`orders-db-prod` is witnessed nowhere, and only about its environment on the
demo SI.

**On the one question a grant always carries.** `spec.access` is `read` or
`readwrite`, and the signature will not take it from the request: `echoes` is a
word test, and a level is a common word — *"do not grant readwrite, only read"*
made `readwrite` look asked for, and *"the read replica of orders-db"* named a
level nobody asked for. So a level is answered at a prompt or it is a question,
which costs one prompt per grant and closes the gap between a request for read
and a grant of write.

**On the environment.** It is never read out of the request's words either,
in any language, for the reason a level is not: a word test cannot read a
negation — *"not prod"*, *"prodではなく"* and *"dont use prod"* each leave
`prod` a whole word — and no list of negations is ever complete. It comes from
the declaration the request points at, or it is asked. Pointing is naming by
its reference in full — `kind:namespace/name`, or `kind:name` in the default
namespace — every thing a right is over, each declaring the one environment,
with nothing else the request mentions declared in another and no negation
anywhere in it. That is `open-network.json` on the demo SI. A thing — a
database, a cache — points at nothing: its environment is always asked.
