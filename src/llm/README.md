# `llm/` — the single crossing point

Everything that reaches a model goes through this folder, and nothing else in the
repository imports the model SDK. An architecture test enforces both
(`tests/architecture/dependencies.test.ts`).

## Why `client.ts` holds only types

`agents/` imports `client.ts`, and the architecture rule walks the **transitive** import
closure of `agents/`. If this file pulled in `ai`, or reached `node:fs` through the
recording, then `agents/` would reach the disk through the back door — and `SECURITY.md`
states there is no code path from an agent to a file.

So: `client.ts` is types only, `recording.ts` takes an abstract `RecordingStore` and
touches nothing, the filesystem implementation lives in `cli/recording-fs.ts`, and
`runtime.ts` is the one file importing `ai`.

## No default model, on purpose

There is no default provider and no default model. With nothing configured the CLI says
`no model configured` and exits 2, rather than picking one for you:

```bash
export IDP_PROVIDER=anthropic|mistral|openai
export IDP_MODEL=<whatever that provider calls it>
```

Credentials come from the provider's own environment variable, never from the repository
(design § 7.0). Adding a fourth provider is one entry in `ADAPTERS` in `providers.ts`.

## Recording and replay

`pnpm test` replays; it never reaches the network, and `tests/setup/offline.ts` makes that
structural rather than a convention.

```bash
IDP_PROVIDER=... IDP_MODEL=... IDP_RECORDING=record pnpm test   # once, with a key
pnpm test                                                        # everyone else
```

A recording carries the provider and model it was made against, and **replay uses those,
not your configuration** — which is what lets you run the whole suite without holding the
key the recording was made with.

The key is `(scenario, agent, turn)`, never a hash of the prompt: hashing would invalidate
every recording on one changed comma. The digest is stored and *compared*, so a prompt that
changed since recording **warns and replays anyway**, while a **missing entry is fatal** —
a warning there would let a brand new scenario pass green having replayed nothing.

One consequence worth knowing before you debug it: turn *n*'s prompt embeds turn *n−1*'s
tool output, so a single changed fixture row cascades digest warnings down the rest of a
scenario. That is also why the SI summary the model sees is bucketed rather than exact.
