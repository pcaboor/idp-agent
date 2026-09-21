# Stage 2 — Question Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go** — Stage 1 shipped with all 36 unticked, which is how a plan stops being a status signal.

**Goal:** Answer a natural-language question about the SI by letting a model choose *which*
questions to ask the graph — never by letting it write the answer — and put the record/replay
recording harness in place so the whole suite still runs with no API key.

**Architecture:** A hand-written, bounded read-only tool loop. The model calls three tools over
`EntityGraph` and must terminate through an `answer` tool whose output is a Zod-validated closed
union. The engine re-reads every reference the model returns before printing a byte, and refuses
any reference no tool actually produced. Model calls are recorded at the AI SDK's `doGenerate`
seam, keyed on `(scenario, agent, turn)`.

**Tech Stack:** TypeScript 7, Node 22+, Vitest 5, Zod 4, Vercel AI SDK (`ai` + `@ai-sdk/*`) in
low-level mode with the loop written by hand.

## Global Constraints

Inherited and still binding — see `docs/design.md`, `AGENTS.md`.

- **`pnpm test` needs no API key, no network and no Docker. Ever.** A change that makes any of
  them necessary is the wrong change (`CONTRIBUTING.md`). The offline floor is enforced by a
  test setup file, not by convention (Task 1).
- **No provider is privileged.** The design ships anthropic · mistral · openai behind one
  interface. There is **no default provider and no default model**: with nothing configured the
  CLI refuses with `no model configured` and exit 2. A contributor plugs in the model they want.
- **A recording carries its own provider and model, and replay uses the recording's, never the
  configured one.** This is what lets a contributor run the whole suite without holding the key
  the recording was made with.
- **English throughout** — code, comments, commit messages, test names, CLI output.
- **`core/` never imports `agents/`, `llm/` or the model SDK; `agents/` reaches neither disk nor
  network, transitively.** Enforced by `tests/architecture` (Task 1).
- **Declare, never infer.** An ambiguous question resolves nothing. A model that names an entity
  no tool returned is refused, and the offending reference is named.
- **Never ignore in silence.** A missing recording entry, an unparseable classification and a
  refused answer all reach stderr. None of them becomes an empty result.
- **The agent drafts, the engine signs** — applied to reads: the model chooses which question to
  ask; `cli/render/` prints the rows.
- No `switch` on a closed union without `const _exhaustive: never = value` in `default`.
- Conventional Commits. Work on a branch; `main` is reached through a merge request.

---

## What the user types

```bash
idp-agent ask "which databases are in prod?"      # a question
idp-agent ask "give billing-api access to orders-db"   # classified MUTATION
```

`ask` is an explicit verb this stage, not the bare intent of design §3. Reason: `parseArguments`
today returns `error` for an unknown first token, and three shipped tests plus one smoke check
assert exactly that (`['nope']`, `['wat']`, `['destroy']`). A bare intent would have to weaken
that guard before there is anything to gain from it. Stage 4 adds the bare form, when a mutation
has somewhere to go.

| Case | stdout | Exit |
|---|---|---|
| question, rows found | the table, from `renderTable` | 0 |
| question, one entity | the detail view, from `renderEntityDetail` | 0 |
| question, nothing matched | `No entity matches that question.` | 1 |
| question the model cannot answer | (stderr) `cannot answer: <reason>` | 3 |
| classified MUTATION | (stderr) `that is a change request; this build only reads (stage 5 writes)` | 3 |
| no model configured | (stderr) `no model configured` + how to set one | 2 |

**Exit 3 is new** — `EXIT.unsupported`. It separates *the graph answered nothing* (1) from *this
build will not act on that* (3). Stage 5 turns the MUTATION branch into a real plan and its 3
into a 0.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/schemas/query.ts` | `searchCriteriaSchema`, the tool input schemas, `answerSchema`, `QUERY_LIMITS` |
| `src/context/graph/summary.ts` | `summariseGraph` — bucketed counts and the closed vocabulary |
| `src/llm/client.ts` | **types only**: `LlmClient`, `GenerateRequest`, `Transcript`, `RecordingMissError` |
| `src/llm/recording.ts` | record/replay, pure: takes a `RecordingStore`, touches no disk |
| `src/llm/providers.ts` | the three provider adapters; no default, `no model configured` when unset |
| `src/llm/runtime.ts` | the only file importing `ai` — `generateText` + `wrapLanguageModel` |
| `src/llm/README.md` | why the crossing point is one file, and how to plug in your own model |
| `src/cli/recording-fs.ts` | `fileRecordingStore(dir)` — the only place `node:fs` meets a recording |
| `src/agents/events.ts` | `AgentEvent`, `EventSink` |
| `src/agents/supervisor.ts` | `classify()` — one turn, no tools, MUTATION or QUESTION |
| `src/agents/analyst.ts` | the bounded loop: 4 turns, 3 calls per turn, terminal `answer` |
| `src/agents/tools/graph-tools.ts` | `buildTools(graph)` — three read tools + `answer`, the witness set |
| `src/agents/summary.ts` | `formatSummary` — the prompt text, sorted and stable |
| `src/agents/README.md` | why `agents/` may not reach the disk, and what that costs |
| `src/cli/commands/ask.ts` | `runAsk` — wires it together, signs the answer, returns a `CommandResult` |
| `tests/setup/offline.ts` | replaces `globalThis.fetch` with a thrower unless recording |
| `tests/recordings/*.json` | five recorded scenarios |

Why `client.ts` holds only types: `agents/` imports it, and the architecture test walks the
**transitive** closure. If the crossing point pulled in `ai`, or the recording pulled in `node:fs`
through it, `agents/` would reach the disk through the back door — which `SECURITY.md` currently
claims is impossible. Task 1 makes that claim true before any of it is written.

---

### Task 1: The offline floor and the transitive architecture rules

Nothing else may be written until the suite cannot reach the network by accident and
`agents/` cannot reach the disk through a dependency.

**Files:**
- Create: `tests/setup/offline.ts`
- Modify: `vitest.config.ts`
- Modify: `tests/architecture/dependencies.test.ts`
- Create then delete: `src/agents/probe.ts` (proves the rule is not vacuous)

**Interfaces:**
- Produces: nothing importable. This task produces guarantees.

- [x] **Step 1: Write the failing test**

Add to `tests/architecture/dependencies.test.ts`, above the existing `describe`:

```typescript
const MODEL_SDK = /^ai$|^@ai-sdk\//
const DISK = /^(node:)?(fs|fs\/promises|child_process|worker_threads|module)$|^(simple-git|isomorphic-git|nodegit)$/
const NETWORK = /^(node:)?(http|https|net|dgram|tls)$|^(undici|axios|node-fetch|got)$/

/**
 * Relative specifiers are resolved and walked; a bare specifier is checked and
 * not walked. The shipped rules grep the files under a directory, which would
 * let agents/ -> llm/client -> recording -> node:fs pass while SECURITY.md claims
 * there is no code path from an agent to the disk.
 */
async function closureOf(entry: string, seen = new Set<string>()): Promise<Import[]> {
  if (seen.has(entry)) return []
  seen.add(entry)
  const found: Import[] = []
  for (const { specifier } of await importsOf(entry)) {
    found.push({ file: path.relative(SOURCE_ROOT, entry), specifier })
    if (!specifier.startsWith('.')) continue
    const resolved = path.resolve(path.dirname(entry), specifier.replace(/\.js$/, '.ts'))
    found.push(...(await closureOf(resolved, seen)))
  }
  return found
}
```

and these four cases inside `describe('architecture')`:

```typescript
it('no module reachable from agents/ touches the disk or the network', async () => {
  const entries = await sourceFiles(path.join(SOURCE_ROOT, 'agents'))
  const closure = (await Promise.all(entries.map((file) => closureOf(file)))).flat()
  expect(closure.filter((i) => DISK.test(i.specifier) || NETWORK.test(i.specifier))).toEqual([])
})

it('only src/llm/ imports the model SDK', async () => {
  const offending = (await importsUnder(SOURCE_ROOT)).filter(
    (i) => MODEL_SDK.test(i.specifier) && !i.file.startsWith('llm/'),
  )
  expect(offending).toEqual([])
})

it('agents/ imports llm/client.js and nothing else from llm/', async () => {
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'agents'))).filter(
    (i) => /(^|\/)llm\//.test(i.specifier) && !/llm\/client\.js$/.test(i.specifier),
  )
  expect(offending).toEqual([])
})

it('core/ does not reach the model SDK', async () => {
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter((i) =>
    MODEL_SDK.test(i.specifier),
  )
  expect(offending).toEqual([])
})
```

You will need `sourceFiles(dir)` and `importsOf(file)` — the existing `importsUnder` already
walks a directory and reads imports; extract those two helpers from it rather than duplicating
the walk.

- [x] **Step 2: Prove the first rule is not vacuous**

`src/agents/` does not exist, so the closure is empty and the rule passes over nothing. Create
`src/agents/probe.ts`:

```typescript
// Temporary. Proves the transitive rule bites. Deleted in step 4.
import { readFile } from 'node:fs/promises'
export const probe = readFile
```

Run: `pnpm vitest run tests/architecture/dependencies.test.ts`
Expected: FAIL — `no module reachable from agents/ touches the disk or the network`, listing
`agents/probe.ts` → `node:fs/promises`.

- [x] **Step 3: Add the offline floor**

Create `tests/setup/offline.ts`:

```typescript
/**
 * The suite must never reach the network — not by accident, not through a
 * dependency, not when someone forgets a recording. Recording is the one
 * exception, and it is opt-in through IDP_RECORDING=record.
 */
const recording = process.env['IDP_RECORDING'] === 'record'

if (!recording) {
  globalThis.fetch = (input: RequestInfo | URL): never => {
    const target = typeof input === 'string' ? input : String(input)
    throw new Error(
      `the test suite reached the network (${target}). ` +
        'Replay a recording, or record one with IDP_RECORDING=record pnpm test.',
    )
  }
}
```

Modify `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/offline.ts'],
  },
})
```

- [x] **Step 4: Delete the probe and run everything**

```bash
rm src/agents/probe.ts
pnpm vitest run
```
Expected: PASS — 129 + 4 architecture tests.

- [x] **Step 5: Commit**

```bash
git add tests/setup/offline.ts vitest.config.ts tests/architecture/dependencies.test.ts
git commit -m "test: forbid the network in the suite and the disk under agents/, transitively"
```

---

### Task 2: The recording, pure

**Files:**
- Create: `src/llm/client.ts` (types only)
- Create: `src/llm/recording.ts`
- Create: `src/cli/recording-fs.ts`
- Create: `tests/unit/recording.test.ts`

**Interfaces:**
- Produces:
  - `interface RecordingStore { read(scenario: string): Promise<Recording | undefined>; write(scenario: string, recording: Recording): Promise<void> }`
  - `function resolveMode(raw: string | undefined): 'replay' | 'record'`
  - `function openRecording(options: { scenario: string; store: RecordingStore; mode: 'replay' | 'record'; warn: (message: string) => void }): Promise<OpenRecording>`
  - `interface OpenRecording { replay(key: TurnKey, digest: string): TurnRecord; record(key: TurnKey, record: TurnRecord): void; save(): Promise<void> }`
  - `class RecordingMissError extends Error`

- [x] **Step 1: Write the failing test**

Create `tests/unit/recording.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { RecordingMissError, openRecording, resolveMode } from '../../src/llm/recording.js'
import type { Recording, RecordingStore } from '../../src/llm/recording.js'

const tape: Recording = {
  version: 1,
  scenario: 'demo',
  turns: [
    {
      agent: 'supervisor',
      turn: 0,
      provider: 'anthropic',
      model: 'claude-opus-5',
      digest: 'sha256:aaa',
      call: { prompt: [{ role: 'user', content: 'hello' }] },
      result: { content: [{ type: 'text', text: 'QUESTION' }], finishReason: 'stop' },
    },
  ],
}

const storeOf = (recording?: Recording): RecordingStore & { written: Recording[] } => {
  const written: Recording[] = []
  return {
    written,
    read: async () => recording,
    write: async (_scenario, value) => void written.push(value),
  }
}

describe('resolveMode', () => {
  it('replays when nothing is set', () => {
    expect(resolveMode(undefined)).toBe('replay')
  })

  it('records only on the documented value', () => {
    expect(resolveMode('record')).toBe('record')
  })

  it('refuses a value it does not recognise, rather than guessing a mode', () => {
    // A contributor who types IDP_RECORDING=1 must not silently diverge from CI.
    expect(() => resolveMode('1')).toThrow(/IDP_RECORDING/)
  })
})

describe('recording replay', () => {
  it('returns the recorded turn for its key', async () => {
    const played = await openRecording({
      scenario: 'demo', store: storeOf(tape), mode: 'replay', warn: () => {},
    })
    expect(played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:aaa').result.finishReason)
      .toBe('stop')
  })

  it('fails on a missing entry, naming how to record it', async () => {
    // A warning here would let a brand new scenario pass green replaying nothing.
    const played = await openRecording({
      scenario: 'demo', store: storeOf(tape), mode: 'replay', warn: () => {},
    })
    expect(() => played.replay({ agent: 'analyst', turn: 0 }, 'sha256:aaa'))
      .toThrow(RecordingMissError)
    expect(() => played.replay({ agent: 'analyst', turn: 0 }, 'sha256:aaa'))
      .toThrow(/IDP_RECORDING=record/)
  })

  it('fails when the whole recording is absent', async () => {
    const played = await openRecording({
      scenario: 'demo', store: storeOf(undefined), mode: 'replay', warn: () => {},
    })
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:aaa'))
      .toThrow(RecordingMissError)
  })

  it('warns and still replays when the prompt changed since recording', async () => {
    // design 9.3: a prompt that changed produces a warning, not an error.
    const warn = vi.fn()
    const played = await openRecording({
      scenario: 'demo', store: storeOf(tape), mode: 'replay', warn,
    })
    const record = played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:different')
    expect(record.result.finishReason).toBe('stop')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/supervisor turn 0/))
  })

  it('is keyed on the turn, never on the prompt', async () => {
    // The key is (scenario, agent, turn). Keying on a hash would invalidate every
    // recording on a single changed comma (design 9.3).
    const warn = vi.fn()
    const played = await openRecording({
      scenario: 'demo', store: storeOf(tape), mode: 'replay', warn,
    })
    expect(() => played.replay({ agent: 'supervisor', turn: 0 }, 'sha256:zzz')).not.toThrow()
  })
})

describe('recording record', () => {
  it('writes the turns it was given, sorted by agent and turn', async () => {
    const store = storeOf(undefined)
    const played = await openRecording({
      scenario: 'demo', store, mode: 'record', warn: () => {},
    })
    played.record({ agent: 'analyst', turn: 1 }, { ...tape.turns[0]!, agent: 'analyst', turn: 1 })
    played.record({ agent: 'analyst', turn: 0 }, { ...tape.turns[0]!, agent: 'analyst', turn: 0 })
    await played.save()
    expect(store.written[0]?.turns.map((t) => t.turn)).toEqual([0, 1])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/recording.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the types**

Create `src/llm/client.ts`. **Types only** — no runtime import, so `agents/` can import it
without pulling `ai` or `node:fs` into its closure:

```typescript
import type { z } from 'zod'

export type AgentName = 'supervisor' | 'analyst' | 'inspector' | 'architect' | 'reviewer'

export interface ModelToolSpec {
  name: string
  description: string
  parameters: z.ZodType
}

/** args is UNVALIDATED: it came from the model. Parse before use. */
export interface ModelToolCall {
  id: string
  name: string
  args: unknown
}

export type Transcript =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[] }
  | { role: 'tool'; id: string; name: string; result: unknown }

export interface GenerateRequest {
  agent: AgentName
  system: string
  transcript: Transcript[]
  tools: ModelToolSpec[]
  toolChoice: 'auto' | 'none' | { tool: string }
}

export interface GenerateResult {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
}

/** The single crossing point (design 10). agents/ imports this file and no other from llm/. */
export interface LlmClient {
  generate(request: GenerateRequest): Promise<GenerateResult>
}
```

- [x] **Step 4: Write the recording**

Create `src/llm/recording.ts`:

```typescript
import type { AgentName } from './client.js'

export interface TurnKey {
  agent: AgentName
  turn: number
}

export interface TurnRecord extends TurnKey {
  provider: string
  model: string
  digest: string
  recordedAt?: string
  handAuthored?: boolean
  call: unknown
  result: { content: unknown[]; finishReason: string; usage?: unknown }
}

export interface Recording {
  version: 1
  scenario: string
  turns: TurnRecord[]
}

export interface RecordingStore {
  read(scenario: string): Promise<Recording | undefined>
  write(scenario: string, recording: Recording): Promise<void>
}

export class RecordingMissError extends Error {}

const keyOf = (key: TurnKey): string => `${key.agent}#${key.turn}`

/**
 * The mode comes from IDP_RECORDING alone — never from whether a key happens to
 * be present, or a contributor's run diverges from CI without either noticing.
 */
export function resolveMode(raw: string | undefined): 'replay' | 'record' {
  if (raw === undefined || raw === '') return 'replay'
  if (raw === 'record') return 'record'
  throw new Error(`IDP_RECORDING must be unset or "record", got "${raw}"`)
}

export interface OpenRecording {
  replay(key: TurnKey, digest: string): TurnRecord
  record(key: TurnKey, record: TurnRecord): void
  save(): Promise<void>
}

export async function openRecording(options: {
  scenario: string
  store: RecordingStore
  mode: 'replay' | 'record'
  warn: (message: string) => void
}): Promise<OpenRecording> {
  const existing = await options.store.read(options.scenario)
  const turns = new Map((existing?.turns ?? []).map((turn) => [keyOf(turn), turn]))

  return {
    replay(key, digest) {
      const found = turns.get(keyOf(key))
      if (found === undefined) {
        throw new RecordingMissError(
          `no recording for ${options.scenario} ${key.agent} turn ${key.turn}. ` +
            'Record it with IDP_RECORDING=record pnpm test.',
        )
      }
      // A changed prompt is a warning, not an error (design 9.3): the digest is
      // compared, never keyed on. Note that turn n embeds turn n-1's output, so
      // one changed fixture row cascades warnings down the rest of a scenario.
      if (found.digest !== digest) {
        options.warn(
          `recording ${options.scenario} ${key.agent} turn ${key.turn}: ` +
            'the prompt changed since recording; replaying anyway',
        )
      }
      return found
    },

    record(key, record) {
      turns.set(keyOf(key), record)
    },

    async save() {
      const sorted = [...turns.values()].sort(
        (a, b) => a.agent.localeCompare(b.agent) || a.turn - b.turn,
      )
      await options.store.write(options.scenario, {
        version: 1,
        scenario: options.scenario,
        turns: sorted,
      })
    },
  }
}
```

Create `src/cli/recording-fs.ts` — the only place `node:fs` meets a recording, and it lives in
`cli/` so that nothing reachable from `agents/` can touch the disk:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Recording, RecordingStore } from '../llm/recording.js'

export function fileRecordingStore(directory: string): RecordingStore {
  const fileOf = (scenario: string): string => path.join(directory, `${scenario}.json`)

  return {
    async read(scenario) {
      const raw = await readFile(fileOf(scenario), 'utf8').catch(() => undefined)
      return raw === undefined ? undefined : (JSON.parse(raw) as Recording)
    },
    async write(scenario, recording) {
      await mkdir(directory, { recursive: true })
      await writeFile(fileOf(scenario), `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
    },
  }
}
```

- [x] **Step 5: Run the tests**

Run: `pnpm vitest run tests/unit/recording.test.ts && pnpm typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/llm/client.ts src/llm/recording.ts src/cli/recording-fs.ts tests/unit/recording.test.ts
git commit -m "feat(llm): record and replay a model turn, keyed on scenario, agent and turn"
```

---

### Task 3: Providers and the runtime, with no privileged default

**Files:**
- Create: `src/llm/providers.ts`
- Create: `src/llm/runtime.ts`
- Create: `src/llm/README.md`
- Create: `tests/unit/providers.test.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: `LlmClient`, `GenerateRequest` from `llm/client.ts`; `OpenRecording` from `llm/recording.ts`
- Produces:
  - `interface ModelChoice { provider: 'anthropic' | 'mistral' | 'openai'; model: string }`
  - `function chooseModel(env: Record<string, string | undefined>): ModelChoice` — throws `NoModelConfiguredError` when unset
  - `class NoModelConfiguredError extends Error`
  - `function createClient(options: { tape: OpenRecording; mode: 'replay' | 'record'; choice?: ModelChoice }): LlmClient`

- [x] **Step 1: Write the failing test**

Create `tests/unit/providers.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { NoModelConfiguredError, chooseModel } from '../../src/llm/providers.js'

describe('chooseModel', () => {
  it('refuses to pick a provider on the user behalf', () => {
    // No default: the project ships three adapters and privileges none, so a
    // contributor plugs in the model they want rather than inheriting ours.
    expect(() => chooseModel({})).toThrow(NoModelConfiguredError)
    expect(() => chooseModel({})).toThrow(/IDP_PROVIDER/)
  })

  it('takes the provider and the model from the environment', () => {
    expect(chooseModel({ IDP_PROVIDER: 'mistral', IDP_MODEL: 'mistral-large-latest' })).toEqual({
      provider: 'mistral',
      model: 'mistral-large-latest',
    })
  })

  it('needs both halves, and says which one is missing', () => {
    expect(() => chooseModel({ IDP_PROVIDER: 'openai' })).toThrow(/IDP_MODEL/)
    expect(() => chooseModel({ IDP_MODEL: 'gpt-x' })).toThrow(/IDP_PROVIDER/)
  })

  it('refuses a provider it has no adapter for, rather than falling back', () => {
    expect(() => chooseModel({ IDP_PROVIDER: 'acme', IDP_MODEL: 'x' })).toThrow(/acme/)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/providers.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Add the dependencies**

```bash
pnpm add ai @ai-sdk/anthropic @ai-sdk/mistral @ai-sdk/openai
```

Pin exact versions in `package.json` (no `^`): a provider adapter's request shape is part of
what a recording recorded. Recordings stay **out** of the `files` array — they are test material,
not shipped.

- [x] **Step 4: Write the providers**

Create `src/llm/providers.ts`:

```typescript
import { createAnthropic } from '@ai-sdk/anthropic'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

export type ProviderName = 'anthropic' | 'mistral' | 'openai'

export interface ModelChoice {
  provider: ProviderName
  model: string
}

export class NoModelConfiguredError extends Error {}

const ADAPTERS: Record<ProviderName, (model: string) => LanguageModel> = {
  anthropic: (model) => createAnthropic()(model),
  mistral: (model) => createMistral()(model),
  openai: (model) => createOpenAI()(model),
}

const NAMES = Object.keys(ADAPTERS) as ProviderName[]

/**
 * No default provider and no default model. The tool ships three adapters and
 * privileges none: whoever picks the project up plugs in the model they want,
 * and an unconfigured run says so instead of reaching for ours.
 */
export function chooseModel(env: Record<string, string | undefined>): ModelChoice {
  const provider = env['IDP_PROVIDER']
  const model = env['IDP_MODEL']

  if (provider === undefined || provider === '') {
    throw new NoModelConfiguredError(
      `no model configured: set IDP_PROVIDER (one of ${NAMES.join(', ')}) and IDP_MODEL`,
    )
  }
  if (!NAMES.includes(provider as ProviderName)) {
    throw new NoModelConfiguredError(
      `no adapter for provider "${provider}"; available: ${NAMES.join(', ')}`,
    )
  }
  if (model === undefined || model === '') {
    throw new NoModelConfiguredError(`no model configured: set IDP_MODEL for ${provider}`)
  }
  return { provider: provider as ProviderName, model }
}

/** Replay uses the recording's own provider and model, never the configured one. */
export function modelFor(choice: ModelChoice): LanguageModel {
  return ADAPTERS[choice.provider](choice.model)
}
```

- [x] **Step 5: Write the runtime**

Create `src/llm/runtime.ts` — the only file importing `ai`:

```typescript
import { generateText, wrapLanguageModel } from 'ai'
import { createHash } from 'node:crypto'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from './client.js'
import type { OpenRecording } from './recording.js'
import { modelFor, type ModelChoice } from './providers.js'

/** Compared, never keyed on. Keying on it would invalidate every recording on a comma. */
const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

export function createClient(options: {
  tape: OpenRecording
  mode: 'replay' | 'record'
  choice?: ModelChoice
}): LlmClient {
  // Turns are counted per agent, by the runtime, never derived from content.
  const turns = new Map<AgentName, number>()

  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const turn = turns.get(request.agent) ?? 0
      turns.set(request.agent, turn + 1)
      const key = { agent: request.agent, turn }

      if (options.mode === 'replay') {
        const record = options.tape.replay(key, digestOf(request))
        return fromRecord(record)
      }

      if (options.choice === undefined) {
        throw new Error('recording needs a configured model')
      }
      // No temperature: it is rejected on several current models, and
      // determinism comes from the recording, not from sampling settings.
      const response = await generateText({
        model: wrapLanguageModel({ model: modelFor(options.choice), middleware: [] }),
        system: request.system,
        messages: toMessages(request.transcript),
        tools: toTools(request.tools),
        toolChoice: request.toolChoice,
      })
      options.tape.record(key, {
        ...key,
        provider: options.choice.provider,
        model: options.choice.model,
        digest: digestOf(request),
        recordedAt: response.response.timestamp.toISOString(),
        call: { system: request.system, transcript: request.transcript },
        result: { content: response.content, finishReason: response.finishReason },
      })
      return toResult(response)
    },
  }
}
```

`fromRecord`, `toMessages`, `toTools` and `toResult` are mechanical adapters between the AI SDK's
shapes and the four types in `client.ts`. Write them in this file; they are the reason
`client.ts` stays free of `ai`.

- [x] **Step 6: Write `src/llm/README.md`**

15-25 lines. It must say: this folder is the single crossing point; `client.ts` is types only
and is the only file `agents/` may import, which is what keeps `ai` and `node:fs` out of the
agent closure; there is no default provider; how to plug in your own model
(`IDP_PROVIDER`/`IDP_MODEL`, and what to add for a fourth adapter); that replay uses the
recording's provider, so the suite runs without your key; and that a changed fixture cascades
digest warnings down a scenario because turn *n* embeds turn *n−1*'s output.

- [x] **Step 7: Run the tests**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, including `only src/llm/ imports the model SDK` from Task 1.

- [x] **Step 8: Commit**

```bash
git add src/llm package.json pnpm-lock.yaml tests/unit/providers.test.ts
git commit -m "feat(llm): add the provider adapters and the recording runtime"
```

---

### Task 4: The SI summary the model is allowed to see

The Supervisor's input is "the request + a numeric SI summary" (design §6). Numeric, and
**bucketed** — stages 3 and 4 both add fixtures, and 33 → 41 entities must not re-record a single
recording.

**Files:**
- Create: `src/context/graph/summary.ts`
- Create: `src/agents/summary.ts`
- Create: `tests/unit/summary.test.ts`

**Interfaces:**
- Consumes: `EntityGraph` from `context/graph/entity-graph.ts`
- Produces:
  - `interface SiSummary { entities: Bucket; components: Bucket; resources: Bucket; danglingReferences: number }`
  - `type Bucket = '0' | '1-9' | '10-99' | '100+'`
  - `interface Vocabulary { kinds: string[]; types: string[]; environments: string[]; owners: string[] }`
  - `function summariseGraph(graph: EntityGraph): { summary: SiSummary; vocabulary: Vocabulary }`
  - `function formatSummary(summary: SiSummary, vocabulary: Vocabulary): string`

- [x] **Step 1: Write the failing test**

Create `tests/unit/summary.test.ts`:

```typescript
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { summariseGraph } from '../../src/context/graph/summary.js'
import { formatSummary } from '../../src/agents/summary.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const load = async (): Promise<EntityGraph> =>
  EntityGraph.from((await new FixtureProvider(ROOT).load()).entities)

const extraDatabase: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'another-db-prod', annotations: { 'company.fr/env': 'prod' } },
  spec: { type: 'database', owner: 'group:default/tiger' },
}

describe('summariseGraph', () => {
  it('counts in buckets, never exactly', async () => {
    const { summary } = summariseGraph(await load())
    expect(summary.entities).toBe('10-99')
    expect(summary.danglingReferences).toBe(0)
  })

  it('lists the closed vocabulary, sorted, and never the entity names', async () => {
    const { vocabulary } = summariseGraph(await load())
    expect(vocabulary.environments).toEqual(['dev', 'prod', 'staging'])
    expect(vocabulary.kinds).toEqual(['Component', 'Resource'])
    expect(vocabulary.types).toEqual([...vocabulary.types].sort())
    expect(vocabulary.types.join()).not.toContain('billing-db-prod')
  })

  it('reports a dangling reference exactly, since it is a health fact and not a scale', () => {
    const orphan: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'ghost', annotations: {} },
      spec: { type: 'database-access', owner: 'group:default/tiger', dependsOn: ['resource:default/gone'] },
    }
    expect(summariseGraph(EntityGraph.from([orphan])).summary.danglingReferences).toBe(1)
  })
})

describe('formatSummary', () => {
  it('does not move when an entity of a known type, env and owner is added', async () => {
    // This is the test that keeps every recording valid through stages 3 and 4.
    const before = summariseGraph(await load())
    const after = summariseGraph(
      EntityGraph.from([...(await load()).all(), extraDatabase]),
    )
    expect(formatSummary(after.summary, after.vocabulary)).toBe(
      formatSummary(before.summary, before.vocabulary),
    )
  })

  it('is byte-stable whatever order the provider loaded entities in', async () => {
    const forward = summariseGraph(await load())
    const backward = summariseGraph(EntityGraph.from([...(await load()).all()].reverse()))
    expect(formatSummary(backward.summary, backward.vocabulary)).toBe(
      formatSummary(forward.summary, forward.vocabulary),
    )
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/summary.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `summariseGraph`**

Create `src/context/graph/summary.ts`. Bucket with `count === 0 ? '0' : count < 10 ? '1-9' :
count < 100 ? '10-99' : '100+'`. Build each vocabulary list with a `Set`, then `.sort()`. Take
`kind`, `spec.type`, the `company.fr/env` annotation and `spec.owner`; skip an undeclared
environment rather than inventing one. Computed in `context/` and handed to `agents/` as plain
data, so `agents/` never holds a graph.

- [x] **Step 4: Implement `formatSummary`**

Create `src/agents/summary.ts`. Emit sorted `key: value` lines, one per field, then the four
vocabulary lists. Deterministic bytes: the prompt digest depends on it, and so does every
recording.

- [x] **Step 5: Run the tests and commit**

```bash
pnpm vitest run tests/unit/summary.test.ts && pnpm typecheck
git add src/context/graph/summary.ts src/agents/summary.ts tests/unit/summary.test.ts
git commit -m "feat(context): summarise the SI in buckets, so a new fixture does not move a prompt"
```

---

### Task 5: The Supervisor and the event stream

**Files:**
- Create: `src/agents/events.ts`
- Create: `src/agents/supervisor.ts`
- Create: `src/agents/README.md`
- Create: `tests/unit/supervisor.test.ts`

**Interfaces:**
- Consumes: `LlmClient` from `llm/client.ts`, `SiSummary` from `context/graph/summary.ts`
- Produces:
  - `type AgentEvent` and `type EventSink = (event: AgentEvent) => void`
  - `function classify(client: LlmClient, input: { intent: string; summary: string }, emit: EventSink): Promise<'MUTATION' | 'QUESTION'>`
  - `class ClassificationError extends Error`

- [x] **Step 1: Write the failing test**

Create `tests/unit/supervisor.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { ClassificationError, classify } from '../../src/agents/supervisor.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'

const clientSaying = (text: string): LlmClient => ({
  generate: async (): Promise<GenerateResult> => ({ text, toolCalls: [], finishReason: 'stop' }),
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

describe('classify', () => {
  it('reads the two classifications the design allows', async () => {
    const { emit } = collect()
    expect(await classify(clientSaying('QUESTION'), { intent: 'x', summary: 'y' }, emit))
      .toBe('QUESTION')
    expect(await classify(clientSaying('MUTATION'), { intent: 'x', summary: 'y' }, emit))
      .toBe('MUTATION')
  })

  it('tolerates surrounding whitespace and case, which is formatting, not meaning', async () => {
    const { emit } = collect()
    expect(await classify(clientSaying('  question\n'), { intent: 'x', summary: 'y' }, emit))
      .toBe('QUESTION')
  })

  it('refuses a third answer rather than defaulting to one of the two', async () => {
    // Declare, never infer: a model that answered UNCLEAR has not classified,
    // and picking QUESTION for it would be guessing on the user behalf.
    const { emit } = collect()
    await expect(classify(clientSaying('UNCLEAR'), { intent: 'x', summary: 'y' }, emit))
      .rejects.toThrow(ClassificationError)
  })

  it('refuses a classification buried in a sentence', async () => {
    const { emit } = collect()
    await expect(
      classify(clientSaying('I think this is a QUESTION about databases'), { intent: 'x', summary: 'y' }, emit),
    ).rejects.toThrow(ClassificationError)
  })

  it('emits the start of the agent, then what it decided, in that order', async () => {
    const { events, emit } = collect()
    await classify(clientSaying('QUESTION'), { intent: 'x', summary: 'y' }, emit)
    expect(events).toEqual([
      { type: 'agent:start', agent: 'supervisor' },
      { type: 'classified', classification: 'QUESTION' },
    ])
  })

  it('emits a refusal before it throws, so the failure is never silent', async () => {
    const { events, emit } = collect()
    await classify(clientSaying('UNCLEAR'), { intent: 'x', summary: 'y' }, emit).catch(() => {})
    expect(events.at(-1)).toMatchObject({ type: 'refused', agent: 'supervisor' })
  })

  it('gives the model no tools, as the design specifies', async () => {
    const seen: unknown[] = []
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request.tools)
        return { text: 'QUESTION', toolCalls: [], finishReason: 'stop' }
      },
    }
    const { emit } = collect()
    await classify(client, { intent: 'x', summary: 'y' }, emit)
    expect(seen).toEqual([[]])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/supervisor.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the events**

Create `src/agents/events.ts`:

```typescript
import type { AgentName } from '../llm/client.js'

/**
 * The harness renders nothing; it emits. The TUI draws these at stage 7, and
 * the tests assert the same stream (design 6.2). repair, plan:ready and ask
 * arrive with the write path at stage 4.
 */
export type AgentEvent =
  | { type: 'agent:start'; agent: AgentName }
  | { type: 'classified'; classification: 'MUTATION' | 'QUESTION' }
  | { type: 'tool:call'; name: string; args: unknown }
  | { type: 'tool:result'; name: string; rows: number; truncated: number }
  | { type: 'answer:ready'; refs: string[] }
  | { type: 'refused'; agent: AgentName; reason: string }

export type EventSink = (event: AgentEvent) => void
```

- [x] **Step 4: Write the Supervisor**

Create `src/agents/supervisor.ts`:

```typescript
import type { LlmClient } from '../llm/client.js'
import type { EventSink } from './events.js'

export class ClassificationError extends Error {}

const SYSTEM = `You classify a request about an infrastructure catalogue.

Answer with exactly one word:
  QUESTION  the request asks about what exists
  MUTATION  the request asks for something to change

No explanation, no punctuation, no other word.`

export async function classify(
  client: LlmClient,
  input: { intent: string; summary: string },
  emit: EventSink,
): Promise<'MUTATION' | 'QUESTION'> {
  emit({ type: 'agent:start', agent: 'supervisor' })

  const result = await client.generate({
    agent: 'supervisor',
    system: SYSTEM,
    transcript: [{ role: 'user', text: `request: ${input.intent}\n\nsi:\n${input.summary}` }],
    tools: [],
    toolChoice: 'none',
  })

  // Trimmed and upper-cased — that is formatting. A word inside a sentence is
  // not: the model was asked for one word, and anything else is a refusal to
  // classify, not a classification to rescue.
  const word = result.text.trim().toUpperCase()
  if (word !== 'MUTATION' && word !== 'QUESTION') {
    const reason = `expected MUTATION or QUESTION, got "${result.text.trim().slice(0, 60)}"`
    emit({ type: 'refused', agent: 'supervisor', reason })
    throw new ClassificationError(reason)
  }

  emit({ type: 'classified', classification: word })
  return word
}
```

- [x] **Step 5: Write `src/agents/README.md`**

15-25 lines: why `agents/` may import neither disk nor network, **transitively** — the guardrail
is structural, there is no code path from an agent to a file; why that forces `client.ts` to be
types only and the recording store to live in `cli/`; what an agent receives (plain data, never a
graph, never a provider); that orchestration is plain TypeScript and no agent decides the
sequence; and the cost, honestly: every capability an agent needs has to be handed to it, which
makes adding one a change in two places.

- [x] **Step 6: Run the tests and commit**

```bash
pnpm vitest run tests/unit/supervisor.test.ts && pnpm typecheck
git add src/agents tests/unit/supervisor.test.ts
git commit -m "feat(agents): classify a request, and refuse a third answer"
```

---

### Task 6: The read-only tool registry

**Files:**
- Create: `src/core/schemas/query.ts`
- Create: `src/agents/tools/graph-tools.ts`
- Create: `tests/unit/graph-tools.test.ts`

**Interfaces:**
- Consumes: `entityRefSchema`, `ownerRefSchema` from `core/schemas/entity.ts`; `EntityGraph`
- Produces:
  - `const QUERY_LIMITS = { maxRows: 25, maxName: 63, maxReason: 300 }`
  - `searchCriteriaSchema`, `getEntityInputSchema`, `getDependenciesInputSchema`, `answerSchema`
  - `type Answer = z.infer<typeof answerSchema>`
  - `function buildTools(graph: EntityGraph): { specs: ModelToolSpec[]; run(call: ModelToolCall): ToolOutcome; witnessed: ReadonlySet<string> }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/graph-tools.test.ts`:

```typescript
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import { QUERY_LIMITS } from '../../src/core/schemas/query.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const tools = async (): ReturnType<typeof buildTools> =>
  buildTools(EntityGraph.from((await new FixtureProvider(ROOT).load()).entities))

const call = (name: string, args: unknown) => ({ id: 'c1', name, args })

describe('graph tools', () => {
  it('exposes exactly the four tools the loop needs', async () => {
    expect((await tools()).specs.map((s) => s.name)).toEqual([
      'search_entities', 'get_entity', 'get_dependencies', 'answer',
    ])
  })

  it('records every reference it returned in the witness set', async () => {
    const built = await tools()
    built.run(call('search_entities', { type: 'database', env: 'prod' }))
    expect(built.witnessed.has('resource:default/billing-db-prod')).toBe(true)
    expect(built.witnessed.has('resource:default/billing-db-dev')).toBe(false)
  })

  it('caps a result and states the truncation rather than trimming in silence', async () => {
    const built = await tools()
    const outcome = built.run(call('search_entities', { kind: 'Resource' }))
    expect(outcome.rows.length).toBeLessThanOrEqual(QUERY_LIMITS.maxRows)
    expect(outcome.truncated).toBeGreaterThan(0)
    expect(JSON.stringify(outcome.result)).toContain('truncated')
  })

  it('says an entity is unknown rather than offering a nearest match', async () => {
    // Declare, never infer: a helpful guess here is how a model ends up
    // answering about an entity that does not exist.
    const built = await tools()
    expect(JSON.stringify(built.run(call('get_entity', { ref: 'resource:default/nope' })).result))
      .toContain('no such entity')
  })

  it('keeps the three directions apart, as the model is a poor judge of which one was meant', async () => {
    const built = await tools()
    const ref = 'resource:default/billing-db-prod'
    const dependencies = built.run(call('get_dependencies', { ref, direction: 'dependencies' }))
    const dependants = built.run(call('get_dependencies', { ref, direction: 'dependants' }))
    expect(JSON.stringify(dependencies.result)).toContain('mysql-prod-01')
    expect(JSON.stringify(dependants.result)).toContain('billing-api-billing-db-prod')
  })

  it('rejects arguments that do not parse, and says which tool', async () => {
    const built = await tools()
    expect(JSON.stringify(built.run(call('search_entities', { kind: 'Banana' })).result))
      .toMatch(/search_entities/)
  })

  it('rejects a search with no criterion, which would return the whole SI', async () => {
    const built = await tools()
    expect(built.run(call('search_entities', {})).result).toBeDefined()
    expect(JSON.stringify(built.run(call('search_entities', {})).result)).toMatch(/criterion/)
  })

  it('refuses an unknown tool name instead of ignoring the call', async () => {
    const built = await tools()
    expect(JSON.stringify(built.run(call('delete_everything', {})).result)).toMatch(/unknown tool/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/graph-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schemas**

Create `src/core/schemas/query.ts`:

```typescript
import { z } from 'zod'
import { entityRefSchema, ownerRefSchema } from './entity.js'

/** Bounds on what a model may ask for and emit. Untrusted input, like a Plan. */
export const QUERY_LIMITS = { maxRows: 25, maxName: 63, maxReason: 300 } as const

export const searchCriteriaSchema = z
  .object({
    kind: z.enum(['Component', 'Resource']).optional(),
    type: z.string().min(1).max(QUERY_LIMITS.maxName).optional(),
    env: z.string().min(1).max(QUERY_LIMITS.maxName).optional(),
    owner: ownerRefSchema.optional(),
    nameContains: z.string().min(1).max(QUERY_LIMITS.maxName).optional(),
  })
  .refine((criteria) => Object.keys(criteria).length > 0, 'a search needs at least one criterion')

export const getEntityInputSchema = z.object({ ref: entityRefSchema })

/**
 * Three named directions, never one "related to" verb: dependenciesOf is the
 * exact transpose of dependantsOf, and consumersOf is a separate multi-hop
 * walk (design 4.1). Collapsing them would let the model pick by accident.
 */
export const getDependenciesInputSchema = z.object({
  ref: entityRefSchema,
  direction: z.enum(['dependencies', 'dependants', 'consumers']),
})

/**
 * The terminal channel — the read side of propose(). Refusal is a MEMBER of
 * the union, not a parse failure: the model has a legal way to say "I cannot",
 * so it never has to approximate in order to stay in schema. refs carries
 * identifiers the engine itself returned; it authorises nothing.
 */
export const answerSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('entities'),
    refs: z.array(entityRefSchema).min(1).max(QUERY_LIMITS.maxRows),
  }),
  z.object({ outcome: z.literal('nothing') }),
  z.object({
    outcome: z.literal('unanswerable'),
    reason: z.string().min(1).max(QUERY_LIMITS.maxReason),
  }),
])

export type Answer = z.infer<typeof answerSchema>
```

- [ ] **Step 4: Write the registry**

Create `src/agents/tools/graph-tools.ts`. `buildTools(graph)` returns the four specs, a `run`
that parses with the matching schema and returns `{ result, rows, truncated }`, and a `witnessed`
set. Rules, all of them load-bearing:

- Every reference in a result is added to `witnessed` before it is returned.
- A result is capped at `QUERY_LIMITS.maxRows` and the outcome carries `truncated: <n more>` —
  never a silent trim.
- A parse failure returns a result the model can read (`{ error: 'search_entities: ...' }`), not
  a thrown exception: the loop must be able to continue after a bad call.
- `get_entity` on an unknown reference returns `{ error: 'no such entity' }`. No nearest match.
- An unknown tool name returns `{ error: 'unknown tool' }`.
- Rows are the same shape `renderTable` consumes, so the answer and the table cannot disagree.

- [ ] **Step 5: Run the tests and commit**

```bash
pnpm vitest run tests/unit/graph-tools.test.ts && pnpm typecheck
git add src/core/schemas/query.ts src/agents/tools tests/unit/graph-tools.test.ts
git commit -m "feat(agents): give the model four bounded read-only tools and a witness set"
```

---

### Task 7: The bounded loop

**Files:**
- Create: `src/agents/analyst.ts`
- Create: `tests/unit/analyst.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `buildTools`, `answerSchema`, `EventSink`
- Produces:
  - `const LOOP_LIMITS = { maxTurns: 4, maxCallsPerTurn: 3 }`
  - `interface AnalystOutcome { answer: Answer; witnessed: ReadonlySet<string>; calls: string[] }`
  - `function answerQuestion(client, tools, input, emit): Promise<AnalystOutcome>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/analyst.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { LOOP_LIMITS, answerQuestion } from '../../src/agents/analyst.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { GenerateResult, LlmClient } from '../../src/llm/client.js'

/** Replays a scripted sequence of model turns, so the loop is tested without a model. */
const scripted = (turns: GenerateResult[]): LlmClient & { calls: number } => {
  const client = {
    calls: 0,
    generate: async (): Promise<GenerateResult> => {
      const turn = turns[client.calls] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      client.calls += 1
      return turn
    },
  }
  return client
}

const toolCall = (name: string, args: unknown) => ({ id: 'c1', name, args })
const fakeTools = (rows: string[]) => ({
  specs: [],
  witnessed: new Set(rows),
  run: () => ({ result: { rows }, rows: rows.length, truncated: 0 }),
})

const collect = (): { events: AgentEvent[]; emit: (e: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

const INPUT = { intent: 'which databases are in prod?', summary: 's', vocabulary: 'v' }

describe('answerQuestion', () => {
  it('returns the answer the model signed off through the answer tool', async () => {
    const client = scripted([
      { text: '', toolCalls: [toolCall('search_entities', { type: 'database' })], finishReason: 'tool-calls' },
      { text: '', toolCalls: [toolCall('answer', { outcome: 'entities', refs: ['resource:default/a'] })], finishReason: 'tool-calls' },
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools(['resource:default/a']), INPUT, emit)
    expect(outcome.answer).toEqual({ outcome: 'entities', refs: ['resource:default/a'] })
  })

  it('stops at the turn limit and reports unanswerable rather than guessing', async () => {
    // A partial guess is the one outcome that must never reach a user: it looks
    // exactly like an answer.
    const client = scripted(
      Array.from({ length: 10 }, () => ({
        text: '', toolCalls: [toolCall('search_entities', { type: 'database' })], finishReason: 'tool-calls',
      })),
    )
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools(['resource:default/a']), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
    expect(client.calls).toBeLessThanOrEqual(LOOP_LIMITS.maxTurns)
  })

  it('refuses an answer naming a reference no tool returned, and names it', async () => {
    // The whole read-side guarantee. Without it the model can state a fact the
    // graph never produced, which is the failure "declare, never infer" forbids.
    const client = scripted([
      { text: '', toolCalls: [toolCall('search_entities', { type: 'database' })], finishReason: 'tool-calls' },
      { text: '', toolCalls: [toolCall('answer', { outcome: 'entities', refs: ['resource:default/invented'] })], finishReason: 'tool-calls' },
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools(['resource:default/a']), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
    expect(JSON.stringify(outcome.answer)).toContain('resource:default/invented')
  })

  it('refuses "nothing" when the tools did return rows', async () => {
    const client = scripted([
      { text: '', toolCalls: [toolCall('search_entities', { type: 'database' })], finishReason: 'tool-calls' },
      { text: '', toolCalls: [toolCall('answer', { outcome: 'nothing' })], finishReason: 'tool-calls' },
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools(['resource:default/a']), INPUT, emit)
    expect(outcome.answer.outcome).toBe('unanswerable')
  })

  it('accepts "nothing" when no tool returned a row', async () => {
    const client = scripted([
      { text: '', toolCalls: [toolCall('answer', { outcome: 'nothing' })], finishReason: 'tool-calls' },
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(outcome.answer).toEqual({ outcome: 'nothing' })
  })

  it('caps the calls it executes in one turn', async () => {
    const many = Array.from({ length: 9 }, () => toolCall('search_entities', { type: 'database' }))
    const client = scripted([
      { text: '', toolCalls: many, finishReason: 'tool-calls' },
      { text: '', toolCalls: [toolCall('answer', { outcome: 'nothing' })], finishReason: 'tool-calls' },
    ])
    const { events, emit } = collect()
    await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(events.filter((e) => e.type === 'tool:call')).toHaveLength(LOOP_LIMITS.maxCallsPerTurn)
  })

  it('refuses an answer whose arguments do not parse', async () => {
    const client = scripted([
      { text: '', toolCalls: [toolCall('answer', { outcome: 'entities', refs: [] })], finishReason: 'tool-calls' },
      { text: '', toolCalls: [toolCall('answer', { outcome: 'nothing' })], finishReason: 'tool-calls' },
    ])
    const { emit } = collect()
    const outcome = await answerQuestion(client, fakeTools([]), INPUT, emit)
    expect(outcome.answer.outcome).toBe('nothing')
  })

  it('emits a readable stream: start, calls, results, then the answer', async () => {
    const client = scripted([
      { text: '', toolCalls: [toolCall('search_entities', { type: 'database' })], finishReason: 'tool-calls' },
      { text: '', toolCalls: [toolCall('answer', { outcome: 'entities', refs: ['resource:default/a'] })], finishReason: 'tool-calls' },
    ])
    const { events, emit } = collect()
    await answerQuestion(client, fakeTools(['resource:default/a']), INPUT, emit)
    expect(events.map((e) => e.type)).toEqual([
      'agent:start', 'tool:call', 'tool:result', 'answer:ready',
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/analyst.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the loop**

Create `src/agents/analyst.ts`. Plain TypeScript, no framework:

```typescript
export const LOOP_LIMITS = { maxTurns: 4, maxCallsPerTurn: 3 } as const
```

- Build the transcript from the intent, the summary and the vocabulary; append each assistant
  turn and each tool result.
- On each turn, execute at most `maxCallsPerTurn` tool calls, emitting `tool:call` before and
  `tool:result` after each. Extra calls in a turn are dropped, and the dropped count is put in
  the transcript so the model knows — never dropped in silence.
- On the **last allowed turn**, set `toolChoice: { tool: 'answer' }` to force termination. Some
  models reject forced tool use with a 400; catch it, retry the same turn with `toolChoice:
  'auto'` and a system line naming the `answer` tool. Both paths are recorded, so the fallback
  is exercised by whichever provider recorded the recording.
- When the model calls `answer`, parse with `answerSchema`. A parse failure is put back in the
  transcript and the loop continues; it is not a crash.
- **The two engine checks**, before returning: every `refs` entry must be in `witnessed`,
  otherwise the outcome becomes `unanswerable` naming the offending reference; and `nothing` is
  accepted only when `witnessed.size === 0`.
- Exhausting `maxTurns` yields `unanswerable`, never a partial answer.

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm vitest run tests/unit/analyst.test.ts && pnpm typecheck
git add src/agents/analyst.ts tests/unit/analyst.test.ts
git commit -m "feat(agents): bound the question loop and refuse an answer the graph never produced"
```

---

### Task 8: `ask`, the CLI, the recordings and the documentation

**Files:**
- Create: `src/cli/commands/ask.ts`
- Modify: `src/cli/index.ts`, `src/cli/commands/result.ts`, `scripts/smoke.mjs`
- Create: `tests/unit/ask.test.ts`, `tests/scenarios/question-mode.test.ts`
- Create: `tests/recordings/*.json` (five scenarios)
- Create: `docs/adr/0007-the-answer-crosses-the-boundary.md`
- Modify: `docs/design.md`, `AGENTS.md`, `README.md`, `SECURITY.md`, `src/cli/README.md`

**Interfaces:**
- Consumes: everything above
- Produces: `function runAsk(options): Promise<CommandResult>`; `EXIT.unsupported = 3`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ask.test.ts` covering `runAsk` against a scripted `LlmClient` (no recording):
one entity found renders the detail view and `found` is true; several render the table; `nothing`
gives `found: false`; `unanswerable` sets `unsupported: true` and writes the reason to stderr;
MUTATION sets `unsupported: true` and never touches the graph. Then extend `tests/unit/main.test.ts`:

```typescript
it('returns 3 when the request is a change this build will not make', async () => {
  const io = capture()
  const code = await main(['ask', 'give billing-api access to orders-db'], {
    root: FIXTURES, recordingDir: RECORDINGS, env: {},
    out: (s) => io.out.push(s), err: (s) => io.err.push(s),
  })
  expect(code).toBe(3)
  expect(io.err.join('')).toContain('this build only reads')
})

it('refuses to pick a model on the user behalf', async () => {
  const io = capture()
  const code = await main(['ask', 'anything'], {
    root: FIXTURES, env: {}, out: (s) => io.out.push(s), err: (s) => io.err.push(s),
  })
  expect(code).toBe(2)
  expect(io.err.join('')).toContain('no model configured')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/ask.test.ts tests/unit/main.test.ts`
Expected: FAIL — `runAsk` not found, and `ask` parses as an unknown command.

- [ ] **Step 3: Widen the command result and the exit codes**

`src/cli/commands/result.ts`:

```typescript
export interface CommandResult {
  text: string
  found: boolean
  /** The request was understood and this build will not act on it (design 11: writing is stage 5). */
  unsupported?: boolean
}
```

`src/cli/index.ts`: `export const EXIT = { ok: 0, notFound: 1, badUsage: 2, unsupported: 3 } as const`,
an `ask` branch in `parseArguments` (`{ name: 'ask'; intent: string }`, error when the intent is
missing or longer than `PLAN_LIMITS.maxIntentLength`), `MainDeps` gains `env?`, `recordingDir?`,
`scenario?` (which recording to replay; the scenario tests set it) and `events?`, and the result mapping becomes
`result.unsupported === true ? EXIT.unsupported : result.found ? EXIT.ok : EXIT.notFound`.
Add the `ask` line to `HELP`.

- [ ] **Step 4: Write `runAsk`**

Create `src/cli/commands/ask.ts`. In order: summarise the graph, open the recording, build the
client, `classify`, and on `QUESTION` run `answerQuestion`. Then **sign the answer** — the whole
point of the stage:

- `entities` → every ref re-read from `EntityGraph`, sorted lexicographically (the model's order
  carries no meaning anyone verified), then `renderEntityDetail` for one and `renderTable` for
  several. `found: true`.
- `nothing` → `No entity matches that question.`, `found: false`.
- `unanswerable` → the reason on stderr, `unsupported: true`. This is the only model-authored
  text in the build, and it never reaches stdout.
- `MUTATION` → `that is a change request; this build only reads (stage 5 writes)`,
  `unsupported: true`.
- `NoModelConfiguredError` → the message on stderr, and `main` maps it to `EXIT.badUsage`.

- [ ] **Step 5: Record the five recordings**

With a provider configured:

```bash
IDP_PROVIDER=<yours> IDP_MODEL=<yours> IDP_RECORDING=record pnpm test
```

Scenarios: `question-prod-databases`, `question-consumers-of-billing-db`,
`question-ambiguous-redis`, `question-unanswerable-ranking`, `mutation-classified-link`. The
`link-*` names of design §9.3 stay reserved for stage 4.

Then verify the recording is real and clean:

```bash
grep -rlE 'sk-[A-Za-z0-9_-]{8}' tests/recordings && echo "SECRET LEAKED" || echo "clean"
pnpm test          # replays, offline, no key in the environment
```

If no key is available, record nothing and write each turn with `"handAuthored": true`, plus a
test asserting that no recording carries that flag — which will fail until they are recorded for
real. **Do not ship a fabricated recording as a real one.**

- [ ] **Step 6: Write `tests/scenarios/question-mode.test.ts`**

One case per recording, driving `main(['ask', ...])` with `recordingDir` pointing at
`tests/recordings` and asserting the exit code and stdout. The load-bearing one:

```typescript
it('prints exactly what renderTable would print, and nothing the model wrote', async () => {
  const io = capture()
  const code = await main(['ask', 'which databases are in prod?'], {
    root: FIXTURES, recordingDir: RECORDINGS, scenario: 'question-prod-databases',
    env: {}, out: (s) => io.out.push(s), err: (s) => io.err.push(s),
  })
  expect(code).toBe(0)
  const graph = EntityGraph.from((await new FixtureProvider(FIXTURES).load()).entities)
  expect(io.out.join('')).toBe(`${runGraph(graph, { type: 'database', env: 'prod' }).text}\n`)
})
```

- [ ] **Step 7: Extend the smoke checks**

In `scripts/smoke.mjs`, add and update the count line:

```javascript
check({ args: ['ask', 'anything at all'], code: 2, stderr: /no model configured/ })
```

The built binary must refuse cleanly with nothing configured — the state a reviewing agent who
just cloned the repository is in.

- [ ] **Step 8: Amend the documents**

- `docs/design.md` §5.1: the carve-out. *One object crosses per direction of authority* — the
  `Plan` authorises writes and carries values; the `Answer` authorises nothing and carries only
  identifiers the engine itself returned and re-reads before printing. State the limit: the
  `witnessed` guard is a read-side guarantee and **does not transfer** to `propose()`.
- `docs/design.md` §6: add the `analyst` row. §6.2: `agent:start` admits `supervisor` and
  `analyst`; add `classified`, `tool:result`, `answer:ready`, `refused`; mark `repair`,
  `plan:ready` and `ask` as stage 4. §9.3: a missing entry is fatal, a changed prompt warns.
  §10: add `llm/runtime.ts`.
- `docs/adr/0007-the-answer-crosses-the-boundary.md`, same template as 0001-0006: why
  `(scenario, agent, turn)`, why a missing entry is fatal where a changed prompt only warns, and
  why the `Answer` may cross. Rejected alternative: keying on a prompt hash.
- `AGENTS.md`: stage table to 2/7; exit code 3; `pnpm smoke` count; the new architecture rules;
  drop the `src/agents/README.md` open question.
- `README.md`: the `ask` command, exit code 3, and that no provider is configured by default.
- `SECURITY.md`: move the two `agents/` rules from *armed* to *guaranteed today* — they are no
  longer vacuous — and add rows for the transitive rule and the offline `fetch` stub.
- `src/cli/README.md`: the `ask` branch and `EXIT.unsupported`.

- [ ] **Step 9: Run everything**

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
```
Expected: PASS, with no key in the environment.

- [ ] **Step 10: Commit**

```bash
git add src tests scripts docs AGENTS.md README.md SECURITY.md package.json
git commit -m "feat(cli): answer a question about the SI, and sign the answer before printing it"
```

---

## Done when

- `idp-agent ask "which databases are in prod?"` prints the same table `graph --type database
  --env prod` prints, and exits 0
- A question the model cannot answer exits 3 with its reason on stderr, and nothing on stdout
- A change request is classified and refused with exit 3, not attempted
- An answer naming an entity no tool returned is refused, and the reference is named
- With no provider configured, the built binary exits 2 saying `no model configured`
- `pnpm test` still needs no API key, no network and no Docker — and now cannot reach the
  network even by accident
- No module reachable from `agents/` imports `fs`, `child_process` or the network, transitively
- Every recording carries the provider and model it was recorded against, and replay uses those

Stage 3 (`init`) scaffolds a repository. Stage 4 puts the Inspector and the Architect behind the
same event stream, and the `Plan` — not the `Answer` — becomes what crosses.
