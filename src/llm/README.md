# `llm/` — the single crossing point

Everything that reaches a model goes through this folder, and nothing else in the
repository imports the model SDK. Two of the thirteen rules in
`tests/architecture/dependencies.test.ts` hold that line: *only `src/llm/` imports the
model SDK*, and *`agents/` imports `llm/client.js` and nothing else from `llm/`*.

## What lives here

| file | what it is |
|---|---|
| `client.ts` | the interface — `LlmClient`, `AgentName`, `ModelToolSpec`, `ModelToolCall`, `Transcript`. **Types only.** |
| `providers.ts` | the three adapters, `chooseModel(env)` and the key it checks, `timeoutOf(env)`, `NoModelConfiguredError`, `ModelSettingError` |
| `failures.ts` | what a call that cannot succeed becomes — `ModelTimeoutError`, `ProviderCallError`, `ModelOutputLimitError`, `ModelRefusalError` — each one line. No SDK import |
| `recording.ts` | the tape, over an abstract `RecordingStore`; `resolveMode`, `RecordingMissError` |
| `runtime.ts` | the one file that calls a model — `generateText`, the tool plumbing, and the live / record / replay switch |
| `tool-schema.ts` | `objectRooted` — the object-rooted JSON Schema a tool is advertised in. Pure; imports nothing from the SDK |

**Two of those six import the SDK**, not one: `providers.ts` names the three `@ai-sdk/*`
adapters and `runtime.ts` calls `ai`. This page claimed for a while that `runtime.ts` was
the only one, which is the drift the architecture rule is written to survive — the rule is
about the *folder*, and the folder is what the test checks.

## Why `client.ts` holds only types

`agents/` imports `client.ts`, and the architecture rule walks the **transitive** import
closure of `agents/`. If this file pulled in `ai`, or reached `node:fs` through the
recording, then `agents/` would reach the disk through the back door — and `SECURITY.md`
states there is no code path from an agent to a file.

So: `client.ts` is types only, `recording.ts` takes an abstract `RecordingStore` and
touches nothing, the filesystem implementation lives in `cli/recording-fs.ts`, and only
`runtime.ts` and `providers.ts` name the SDK at all.

## A tool is advertised object-rooted, and accepted on its union

Anthropic refuses a tool whose schema has no `type: "object"` root, which is what the
`answer` and `verdict` unions convert to, so `toTools` advertises every tool through
`objectRooted`: the discriminator becomes a required `enum`, a field that only some branches
have, or only some require, says which in its description, and a field the branches give
different schemas is offered as an `anyOf` of them. The flat object is looser than the
union, and the client does not close that gap: the SDK validates against the union but
hands an invalid call back unchanged. The gate is on the other side — every tool's handler
in `agents/` parses the call against its own Zod schema, and the Analyst and the Reviewer
hand a failed `answer` or `verdict` back for repair. It lives here and not in the agents'
schemas because this is the single crossing point, and because `spec.parameters` is inside
the recording digest, where reshaping it would stale every tape. The digest does **not**
cover the advertised JSON Schema: the existing tapes were recorded against the union shape
and replay without a warning, which is sound only because the argument shape is identical,
and the next re-record captures the new one. `tests/contract/providers.test.ts` checks the
bytes each adapter actually sends, which no tape can — replay never builds an adapter.

## No default model, on purpose

There is no default provider and no default model. With nothing configured the CLI says
`no model configured` and exits 2, rather than picking one for you:

```bash
export IDP_PROVIDER=anthropic|mistral|openai
export IDP_MODEL=<whatever that provider calls it>
```

Credentials come from the provider's own environment variable, never from the repository
(design § 7.0) — `.idp-agent.yml` has no field that could carry one. `chooseModel` checks
that the variable is set — `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY` or `OPENAI_API_KEY`,
listed in `KEY_VARIABLES` — and refuses with exit 2 naming it, so a missing key is said
before the Supervisor or the Inspector starts rather than found by the SDK at the first
request. It checks the key and never reads it into the choice, so the key reaches nothing the
choice is copied into; the adapter reads it itself. Neither a replay nor an injected client
calls `chooseModel`, which is why the suite runs with no key. Adding a fourth provider is one
entry in `ADAPTERS` and one in `KEY_VARIABLES`.

## A call that cannot succeed

Every live call is bounded by `IDP_TIMEOUT` — seconds, 120 by default, a plain positive
decimal or exit 2. The bound covers the whole call, the SDK's own two retries of a 429 or a
5xx included. When it expires the request is aborted with a signal the SDK reads as an
abort, so it is never retried, and the run ends on `ModelTimeoutError`. Before this, one
request to gpt-6-luna waited five minutes on undici's headers timeout and was then retried
in silence. The signal is an argument of the call, not a field of the request, so it never
enters a recording's digest.

What a call can end on, and the line each becomes (`failures.ts`, exit 1 in `cli/index.ts`):

| failure | line, after `<provider> <model>` |
|---|---|
| no answer within `IDP_TIMEOUT` | `did not answer within 120 s; set IDP_TIMEOUT=<seconds> to wait longer` |
| HTTP 401 / 403 | `: the key was refused (HTTP 401); check OPENAI_API_KEY` |
| HTTP 429 | `: rate limited (HTTP 429)` |
| an empty account, on a 429 or a 400 | `: the account is out of quota (HTTP 429)` |
| HTTP 5xx | `: the provider failed (HTTP 503)` |
| a context-length refusal | `: the request is longer than the model's context window (HTTP 400)` |
| a refused forced tool choice | `: the model does not take a forced tool choice (HTTP 400): <the provider's words>` |
| any other 4xx | `: the request was refused (HTTP 400): <the provider's words>` |
| a 200 the adapter cannot parse | `: the provider's answer could not be read (HTTP 200)` |
| no connection | `: could not reach the provider: <the SDK's words>` |
| a turn cut off at its output limit with nothing in it | `: the model hit its output limit before answering` |
| a content filter | `: the provider refused to answer` |

The status decides first; the provider's words decide only what a status cannot — its
message and the error code the adapter parsed (`insufficient_quota`, `context_length_exceeded`),
never the raw body, which as often as not echoes the request, and the request is a catalogue:
a 400 quoting `billing-db` is not an empty account. Only the two refusals and a lost
connection carry words of their own, summarised: controls and escape sequences removed,
anything shaped like a key masked, one line, 120 characters at most. The rest are fixed
sentences, and that is deliberate — `agents/forced-turn.ts` retries a forced turn as an open
one when an error mentions `tool_choice` or a `forced tool`, which is right for a provider
that refuses a forced tool with a 400 and wrong for a timeout or a refused key. Which 400 is
that one is decided in `runtime.ts` on the provider's whole message, before the summary cuts
it, and its line says `forced tool` in words of its own. A forced turn that comes back with
no call because it was cut off or filtered is judged by its finish reason before the fallback
sees it, for the same reason.

A timer that expires while the SDK waits to retry a 429 or a 5xx, or a host it cannot reach,
has expired on a provider that did answer: the run ends on that answer — `rate limited
(HTTP 429)` — rather than on "did not answer". Each attempt's failure is seen through a
middleware around the adapter, since the SDK says nothing of one until the last fails.

The check on a returned turn runs in every mode, so a replayed tape cannot hand an agent a
turn a live run would have refused. A run that fails on one saves no tape — the command
writes it only after a run that succeeded — so the replay check is there for a tape written
by hand, or by a build before the check.

**No `maxOutputTokens`, and no variable for one.** Every agent's output is a tool call of a
few hundred tokens, so a cap would bound nothing in practice — except on a reasoning model,
where reasoning tokens count against it and a cap tight enough to matter produces exactly
the empty `length` turn above. The provider's own limit stands (the Anthropic adapter
already sends the model's maximum when it knows the model), and what bounds a call's time and cost is the timeout.

## Recording and replay

`pnpm test` replays; it never reaches the network, and `tests/setup/offline.ts` makes that
structural rather than a convention — it replaces `fetch` with a thrower unless
`IDP_RECORDING=record`.

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

## The third way in, and why it exists

A recording is not the only keyless path. `MainDeps.client` takes an `LlmClient`
outright, so a test drives a whole agent-backed command on a scripted sequence of turns —
no key, no tape, no network. It is what lets `plan "<intent>"` and `init` be asserted end
to end, exit code included, without a recording existing for every branch of the repair
loop.

**What it does not cover:** a scripted client proves the wiring, never the model. Only a
recording says anything about what a real provider actually returned, which is why the
scenario suite still exists and why recording is a deliberate act a human performs with a
key — never something a test does on its own.
