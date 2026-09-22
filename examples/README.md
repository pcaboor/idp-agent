# Example plans

Each file is a `Plan` — the JSON an Architect would produce. `plan --from` reads
one, signs it, runs the policies, re-checks it against the repository, and shows
the diff it would produce. It writes nothing, ever.

```bash
idp-agent init platform /tmp/mon-iac --owner @acme/platform
idp-agent plan --from examples/add-access.json --repo /tmp/mon-iac
```

| file | what it shows | exit |
|---|---|---|
| `add-access.json` | a plan every value of which is vouched for: the unified diff it would produce | 0 |
| `needs-an-owner.json` | an owner nobody can vouch for, asked about rather than guessed | 3 |
| `unvouched-name.json` | a name carrying a segment the request never mentioned | 3 |

Running `add-access.json` twice against the same repository is worth doing: the
second run has nothing to change, and says so without producing a diff.

**On the order of the gates.** The signature runs before the policies, and it is
strict: on a freshly scaffolded repository nothing is witnessed yet, so almost
any invented value becomes a question before a policy ever sees it. The policies
earn their place against a repository that already holds entities — which is
also when an environment can be vouched for by something other than the request.
