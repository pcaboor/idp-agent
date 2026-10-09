import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { recheckPlan } from '../../src/core/plan/recheck.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { committed } from '../support/git.js'

/**
 * Stage 8, slice 2, Task 2.3: `idpa init` reads both repositories — the
 * service `--project` names, and the declarations repository `plan`'s chain
 * finds (`IDP_REPO`, or `repo` in the personal config.yml) — and runs the five
 * gates over the Architect's draft, the Reviewer last, the Architect drafting
 * again what a gate refuses.
 *
 * Every run here goes through `main`, so the declarations repository is found
 * the way a person's is, and every request a scripted model is sent is kept.
 * The declarations repository is a copy of `fixtures/si-demo`, made per test;
 * the fixture itself is never touched.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password is a marked placeholder.
 */

vi.mock('../../src/core/plan/sign.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/plan/sign.js')>()
  return { ...real, signPlan: vi.fn(real.signPlan) }
})
vi.mock('../../src/core/plan/recheck.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/plan/recheck.js')>()
  return { ...real, recheckPlan: vi.fn(real.recheckPlan) }
})

beforeEach(() => {
  vi.mocked(signPlan).mockClear()
  vi.mocked(recheckPlan).mockClear()
})

const made: string[] = []
/** Folders a test locked, unlocked before they are removed. */
const locked: string[] = []
afterAll(async () => {
  await Promise.all(locked.splice(0).map((dir) => chmod(dir, 0o755)))
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const temp = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'idp-init-both-'))
  made.push(dir)
  return dir
}

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

/** A copy of the demo SI: a declarations repository by its markers, and nobody's but this test's. */
const declarations = async (): Promise<string> => {
  const root = path.join(await temp(), 'iac')
  await cp(DEMO, root, { recursive: true })
  return root
}

const SAMPLE_PASSWORD = 'S4mple-Passw0rd-7Qz'
const LOCAL_PASSWORD = 'Local-Passw0rd-3Mv'

/**
 * `invoicing-worker`, committed: its manifest, its CODEOWNERS, a committed
 * `.env.example` whose `DATABASE_URL` holds a marked password, and — untracked
 * — a `.env` holding another.
 */
const service = async (): Promise<string> => {
  const root = path.join(await temp(), 'invoicing-worker')
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(
      { name: 'invoicing-worker', dependencies: { mysql2: '^3.9.0', ioredis: '^5.4.0' } },
      null,
      2,
    )}\n`,
    CODEOWNERS: '*  @acme/tiger\n',
    '.env.example': `DATABASE_URL=mysql://app_billing:${SAMPLE_PASSWORD}@localhost:3306/billing\n`,
    'src/index.ts': 'export const start = () => 0\n',
    '.gitignore': '.env\n',
  }
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text, 'utf8')
  }
  await committed(root)
  await writeFile(
    path.join(root, '.env'),
    `DATABASE_URL=mysql://app_billing:${LOCAL_PASSWORD}@billing-db.prod.internal:3306/billing\n`,
  )
  return root
}

const call = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

/** Replays turns keyed by agent, and keeps a copy of every request it was sent. */
const scripted = (turns: Partial<Record<AgentName, GenerateResult[]>>): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

/** What the Inspector reads, and reports: the name and the forge handle, and nothing a file does not state. */
const INSPECTING: GenerateResult[] = [
  {
    text: '',
    toolCalls: ['package.json', 'CODEOWNERS'].map((file) => ({ id: `read-${file}`, name: 'read_file', args: { path: file } })),
    finishReason: 'tool-calls',
  },
  call(REPORT_TOOL, {
    name: 'invoicing-worker',
    type: { unknown: 'no file states it' },
    lifecycle: { unknown: 'no file states it' },
    runtime: { unknown: 'no file states it' },
    owner: { unknown: 'no file states an entity reference' },
    forgeHandle: '@acme/tiger',
  }),
]

const component = (name = 'invoicing-worker') => ({
  op: 'create-entity',
  entity: {
    kind: 'Component',
    metadata: { name },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  },
})

const PROPOSING = call(PROPOSE_TOOL, { operations: [component()] })
const OK = call(VERDICT_TOOL, { verdict: 'ok' })
const reject = (reason: string): GenerateResult => call(VERDICT_TOOL, { verdict: 'reject', reason })

const TYPED_FLAGS = [
  '--name', 'invoicing-worker',
  '--type', 'service',
  '--lifecycle', 'production',
  '--owner', 'group:default/tiger',
]

interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
  readonly events: AgentEvent[]
}

/**
 * `idpa init` through `main`, with `IDP_REPO` naming `repo` when given and
 * nothing else configured; `over` sets the working directory or adds to the
 * environment.
 */
const run = async (
  args: string[],
  client: LlmClient,
  repo?: string,
  over: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<Ran> => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(args, {
    client,
    cwd: over.cwd ?? (await temp()),
    // No personal config.yml: XDG_CONFIG_HOME names an empty folder.
    env: { XDG_CONFIG_HOME: await temp(), ...(repo === undefined ? {} : { IDP_REPO: repo }), ...over.env },
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    events: (event) => void events.push(event),
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

const requestsOf = (client: { seen: GenerateRequest[] }, agent: AgentName): GenerateRequest[] =>
  client.seen.filter((request) => request.agent === agent)

/** The opening message a request was sent. */
const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

/** The catalogue's summary in an Architect's opening: from `si:` to the end. */
const summaryOf = (opening: string): string => opening.slice(opening.indexOf('\nsi:\n') + 1)

/** Every string a value holds, raw: never `JSON.stringify`, which escapes what it would hide. */
const leaves = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(leaves)
      : typeof value === 'object' && value !== null
        ? Object.values(value).flatMap(leaves)
        : []

describe('init reads the declarations repository plan reads', () => {
  it('finds the declarations repository as plan finds it, and says so when there is none', async () => {
    const repo = await declarations()
    const project = await service()

    const init = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
    await run(['init', '--project', project, ...TYPED_FLAGS], init, repo)
    // What `plan` sends the Architect about the same repository, from the same
    // service, through the same chain.
    const plan = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
    await run(['plan', 'declare invoicing-worker', '--project', project], plan, repo)

    const told = summaryOf(openingOf(requestsOf(init, 'architect')[0]))
    expect(told).toMatch(/^si:\n/)
    expect(told).not.toContain('  entities: 0\n')
    expect(told).toContain('group:default/tiger')
    expect(told).toBe(summaryOf(openingOf(requestsOf(plan, 'architect')[0])))

    const alone = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
    const { err } = await run(['init', '--project', project, ...TYPED_FLAGS], alone)
    expect(summaryOf(openingOf(requestsOf(alone, 'architect')[0]))).toContain('  entities: 0')
    expect(err).toContain('no declarations repository found')
    expect(err).toContain('IDP_REPO')
    expect(err).toContain('repo in ')
  })

  it('runs the five gates, the Reviewer last, and tells it what the Component writes', async () => {
    const repo = await declarations()
    const project = await service()
    const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })

    const { code, out, events } = await run(['init', '--project', project, ...TYPED_FLAGS], client, repo)

    expect(code).toBe(0)
    expect(out).toContain('+++ b/catalog-info.yaml')
    const passed = events.flatMap((event) => (event.type === 'gate:passed' ? [event.gate] : []))
    expect(passed).toEqual(['zod', 'signature', 'policy', 'recheck', 'reviewer'])
    const reviewer = requestsOf(client, 'reviewer')
    expect(reviewer).toHaveLength(1)
    const opening = openingOf(reviewer[0])
    expect(opening).toContain('"name": "invoicing-worker"')
    expect(opening).toContain("operations.0 creates catalog-info.yaml in the service's repository")
  })

  it('drafts again what the Reviewer refuses, and stops cleanly at three', async () => {
    const repo = await declarations()
    const project = await service()

    const twice = scripted({
      inspector: INSPECTING,
      architect: [PROPOSING, PROPOSING, PROPOSING],
      reviewer: [reject('not what was asked'), reject('still not what was asked'), OK],
    })
    const passed = await run(['init', '--project', project, ...TYPED_FLAGS], twice, repo)
    expect(passed.code).toBe(0)
    expect(passed.out).toContain('+++ b/catalog-info.yaml')
    expect(requestsOf(twice, 'architect')).toHaveLength(3)
    expect(openingOf(requestsOf(twice, 'architect')[1])).toContain('not what was asked')

    const always = scripted({
      inspector: INSPECTING,
      architect: [PROPOSING, PROPOSING, PROPOSING],
      reviewer: [reject('no'), reject('no'), reject('no')],
    })
    const stopped = await run(['init', '--project', project, ...TYPED_FLAGS], always, repo)
    expect(stopped.code).toBe(1)
    expect(stopped.out).toContain('refused at the reviewer gate')
    expect(stopped.out).not.toContain('+++ b/catalog-info.yaml')
  })

  it('hands a draft that declares more than the service back to the Architect', async () => {
    const repo = await declarations()
    const project = await service()
    const database = {
      op: 'create-entity',
      entity: {
        kind: 'Resource',
        metadata: { name: 'invoicing-db-prod', env: 'prod' },
        spec: { type: 'database', owner: 'group:default/tiger' },
      },
    }
    const client = scripted({
      inspector: INSPECTING,
      architect: [call(PROPOSE_TOOL, { operations: [component(), database] }), PROPOSING],
      reviewer: [OK],
    })

    const { code, out } = await run(['init', '--project', project, ...TYPED_FLAGS], client, repo)

    expect(code).toBe(0)
    expect(out).toContain('+++ b/catalog-info.yaml')
    const second = openingOf(requestsOf(client, 'architect')[1])
    expect(second).toContain('operations.1: init declares this repository and nothing else')
  })

  it('never proposes again a name the declarations repository gives a Component', async () => {
    const repo = await declarations()
    const project = await service()

    const typed = scripted({ inspector: INSPECTING, architect: [call(PROPOSE_TOOL, { operations: [component('billing-api')] })], reviewer: [OK] })
    const named = await run(
      ['init', '--project', project, '--name', 'billing-api', '--type', 'service', '--lifecycle', 'production', '--owner', 'group:default/tiger'],
      typed,
      repo,
    )
    expect(named.out).toContain(
      'nothing to change — a Component named billing-api is already declared (components/billing-api.yml); nothing is proposed',
    )
    expect(named.out).not.toContain('+++ b/')
    expect(requestsOf(typed, 'reviewer')).toEqual([])

    // Nobody typed it: the Architect proposed it, and the name is asked,
    // the declaration shown.
    const drafted = scripted({ inspector: INSPECTING, architect: [call(PROPOSE_TOOL, { operations: [component('billing-api')] })], reviewer: [OK] })
    const asked = await run(
      ['init', '--project', project, '--type', 'service', '--lifecycle', 'production', '--owner', 'group:default/tiger'],
      drafted,
      repo,
    )
    expect(asked.code).toBe(3)
    expect(asked.out).toContain('operations.0.entity.metadata.name')
    expect(asked.out).toContain('components/billing-api.yml')
    expect(asked.out).not.toContain('+++ b/')
    expect(requestsOf(drafted, 'reviewer')).toEqual([])
  })

  it('reads a declarations repository as plan reads it, and adds no refusal of its own', async () => {
    const repo = await declarations()
    const project = await service()
    const closed = path.join(repo, 'catalog', 'queues')
    await mkdir(closed)
    await chmod(closed, 0o000)
    locked.push(closed)

    // A request that vouches for every value of the Component, so `plan`'s
    // run reaches its re-check rather than stopping on a question.
    const plan = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
    await run(['plan', 'declare invoicing-worker, a production service owned by group:default/tiger', '--project', project], plan, repo)
    const planned = vi.mocked(recheckPlan).mock.results.map((one) => one.value as ReturnType<typeof recheckPlan>)
    const theirs = planned.flatMap((one) => one.standing.filter((violation) => violation.rule === 'unreadable-folder'))
    expect(theirs.length).toBeGreaterThan(0)

    vi.mocked(recheckPlan).mockClear()
    const init = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
    const { code, out } = await run(['init', '--project', project, ...TYPED_FLAGS], init, repo)
    const ours = vi
      .mocked(recheckPlan)
      .mock.results.flatMap((one) =>
        (one.value as ReturnType<typeof recheckPlan>).standing.filter((violation) => violation.rule === 'unreadable-folder'),
      )
    expect(ours).toEqual(theirs)
    // Standing, never the plan's: the run drafts, and previews.
    expect(requestsOf(init, 'architect').length).toBeGreaterThan(0)
    expect(code).toBe(0)
    expect(out).toContain('+++ b/catalog-info.yaml')
    expect(out).toContain('1 error already in the repository, in files this plan does not touch')
  })

  it('sends no model a byte of what the discovery read, the Reviewer included', async () => {
    const repo = await declarations()
    const project = await service()
    const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })

    const { out } = await run(['init', '--project', project, ...TYPED_FLAGS], client, repo)

    expect(requestsOf(client, 'reviewer').length).toBeGreaterThan(0)
    const discovered = ['app_billing', 'localhost:3306/billing', 'DATABASE_URL', '•••', 'a sample states']
    // Not vacuous: each is in what the run printed.
    for (const text of discovered) expect(out, text).toContain(text)
    for (const request of client.seen) {
      for (const leaf of leaves(request)) {
        for (const text of [...discovered, SAMPLE_PASSWORD, LOCAL_PASSWORD]) {
          expect(leaf.includes(text), `${text} sent to ${request.agent}`).toBe(false)
        }
      }
    }
  })

  it('asks the owner and the type of the service’s own Component, whatever the catalogue uses', async () => {
    const repo = await declarations()
    const project = await service()
    const reading = (): LlmClient & { seen: GenerateRequest[] } =>
      scripted({
        inspector: INSPECTING,
        architect: [call('search_entities', { owner: 'group:default/tiger' }), PROPOSING],
        reviewer: [OK],
      })

    const client = reading()
    const asked = await run(['init', '--project', project, '--name', 'invoicing-worker', '--lifecycle', 'production'], client, repo)
    // The precondition: the catalogue uses both values, and the Architect read tiger.
    const opening = openingOf(requestsOf(client, 'architect')[0])
    expect(opening).toMatch(/ {2}owners: .*group:default\/tiger/)
    expect(opening).toMatch(/ {2}types: .*\bservice\b/)
    expect(JSON.stringify(requestsOf(client, 'architect')[1]?.transcript)).toContain('group:default/tiger')

    expect(asked.code).toBe(3)
    expect(asked.out).toContain('operations.0.entity.spec.owner')
    expect(asked.out).toContain('operations.0.entity.spec.type')
    expect(asked.out).toContain('the Inspector, a model, read the forge handle @acme/tiger, which names no group')
    const classes = vi.mocked(signPlan).mock.results.flatMap((one) => {
      const value = one.value as ReturnType<typeof signPlan>
      return 'classified' in value ? value.classified : []
    })
    for (const path of ['operations.0.entity.spec.owner', 'operations.0.entity.spec.type']) {
      const found = classes.filter((leaf) => leaf.path === path)
      expect(found.length, path).toBeGreaterThan(0)
      for (const leaf of found) expect(leaf.class, path).not.toBe('enumerated')
    }

    vi.mocked(signPlan).mockClear()
    const typed = await run(['init', '--project', project, ...TYPED_FLAGS], reading(), repo)
    expect(typed.code).toBe(0)
    const echoed = vi.mocked(signPlan).mock.results.flatMap((one) => {
      const value = one.value as ReturnType<typeof signPlan>
      return 'classified' in value ? value.classified : []
    })
    for (const path of ['operations.0.entity.spec.owner', 'operations.0.entity.spec.type']) {
      const found = echoed.filter((leaf) => leaf.path === path)
      expect(found.length, path).toBeGreaterThan(0)
      for (const leaf of found) expect(leaf.class, path).toBe('echoed')
    }
  })

  it('says the report’s comparison is not made yet, and claims no read on a run that found none', async () => {
    const repo = await declarations()
    const project = await service()
    const NOT_COMPARED = 'not compared: this version matches nothing against a declarations repository yet'

    const found = await run(['init', '--project', project, ...TYPED_FLAGS], scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] }), repo)
    expect(found.out).toContain(NOT_COMPARED)
    expect(found.out).not.toContain('init reads no declarations repository')

    // Nothing names one: stderr says so, and the report says nothing of a read.
    const alone = await run(['init', '--project', project, ...TYPED_FLAGS], scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] }))
    expect(alone.err).toContain('no declarations repository found')
    expect(alone.out).toContain(NOT_COMPARED)
    expect(alone.out).not.toContain('reads the declarations repository')
  })
})

/**
 * What 2.3's review found, each kept by a test of its own: the service's own
 * Component's `dependsOn` is the person's too; the service is never the
 * declarations repository it is judged against; a scope stop shows the plan it
 * refused; and `init` finds its declarations repository by those two steps of
 * `plan`'s chain alone, refusing a broken one before any model.
 */
describe('init keeps its two repositories apart', () => {
  it('asks a dependsOn the Architect read off the catalogue, and previews nothing', async () => {
    const repo = await declarations()
    const project = await service()
    const reaching = {
      ...component(),
      entity: { ...component().entity, spec: { ...component().entity.spec, dependsOn: ['resource:default/billing-db-prod'] } },
    }
    const client = scripted({
      inspector: INSPECTING,
      architect: [call('get_entity', { ref: 'resource:default/billing-db-prod' }), call(PROPOSE_TOOL, { operations: [reaching] })],
      reviewer: [OK],
    })

    const { code, out } = await run(['init', '--project', project, ...TYPED_FLAGS], client, repo)

    // The precondition: the Architect was handed the Resource by a graph tool.
    expect(JSON.stringify(requestsOf(client, 'architect')[1]?.transcript)).toContain('billing-db-prod')
    expect(code).toBe(3)
    expect(out).toContain('operations.0.entity.spec.dependsOn.0')
    expect(out).not.toContain('+++ b/')
    const classes = vi.mocked(signPlan).mock.results.flatMap((one) => {
      const value = one.value as ReturnType<typeof signPlan>
      return 'classified' in value ? value.classified : []
    })
    const entry = classes.filter((leaf) => leaf.path === 'operations.0.entity.spec.dependsOn.0')
    expect(entry.length).toBeGreaterThan(0)
    for (const leaf of entry) expect(leaf.class).toBe('novel')
  })

  it('refuses a service that is the declarations repository it reads, before any model', async () => {
    const repo = await declarations()
    const cases: Array<{ what: string; args: string[]; cwd?: string; repo?: string; says: string }> = [
      { what: '--project naming IDP_REPO', args: ['--project', repo], repo, says: 'IDP_REPO' },
      { what: 'standing in IDP_REPO', args: [], cwd: repo, repo, says: '--project' },
      {
        what: '--project under its catalog/',
        args: ['--project', path.join(repo, 'catalog', 'databases')],
        repo,
        says: 'catalog',
      },
      {
        what: '--project under its dependencies/',
        args: ['--project', path.join(repo, 'dependencies')],
        repo,
        says: 'dependencies',
      },
      { what: '--project a declarations repository, none configured', args: ['--project', repo], says: 'declarations repository' },
    ]
    for (const one of cases) {
      const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
      const { code, err, out } = await run(['init', ...one.args, ...TYPED_FLAGS], client, one.repo, {
        ...(one.cwd === undefined ? {} : { cwd: one.cwd }),
      })
      expect(code, one.what).toBe(2)
      expect(client.seen, one.what).toEqual([])
      expect(out, one.what).not.toContain('+++ b/')
      expect(err, one.what).toContain('--project')
      expect(err, one.what).toContain(one.says)
    }
  })

  it('shows the plan a scope refused three times, and asks nobody for a value', async () => {
    const repo = await declarations()
    const project = await service()
    const database = {
      op: 'create-entity',
      entity: {
        kind: 'Resource',
        metadata: { name: 'invoicing-db-prod', env: 'prod' },
        spec: { type: 'database', owner: 'group:default/tiger' },
      },
    }
    const over = call(PROPOSE_TOOL, { operations: [component(), database] })
    const client = scripted({ inspector: INSPECTING, architect: [over, over, over], reviewer: [OK] })

    const { code, out } = await run(['init', '--project', project, ...TYPED_FLAGS], client, repo)

    expect(code).toBe(1)
    expect(out).toContain('operations.1: init declares this repository and nothing else')
    expect(out).not.toContain('No draft ever parsed')
    expect(out).toContain('the plan as it stood when it was refused')
    expect(out).toContain('invoicing-db-prod')
    expect(out).not.toContain('Name the value the gate could not accept')
    expect(out).toContain("init declares this service's Component and nothing else")
    expect(requestsOf(client, 'reviewer')).toEqual([])
  })

  it('takes the declarations repository from config.yml’s repo when IDP_REPO is unset', async () => {
    const repo = await declarations()
    const project = await service()
    const xdg = await temp()
    const file = path.join(xdg, 'idp-agent', 'config.yml')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `repo: ${repo}\n`, 'utf8')
    const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })

    const { code, err } = await run(['init', '--project', project, ...TYPED_FLAGS], client, undefined, {
      env: { XDG_CONFIG_HOME: xdg },
    })

    expect(code).toBe(0)
    expect(err).toContain(`reading the declarations repository iac (${file}); IDP_REPO or repo in ${file} names another`)
    expect(summaryOf(openingOf(requestsOf(client, 'architect')[0]))).toContain('group:default/tiger')
  })

  it('says only IDP_REPO names another when IDP_REPO named it', async () => {
    const repo = await declarations()
    const project = await service()
    const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })

    const { err } = await run(['init', '--project', project, ...TYPED_FLAGS], client, repo)

    expect(err).toContain('reading the declarations repository iac (IDP_REPO); IDP_REPO names another')
    expect(err).not.toContain('repo in ')
  })

  it('never reads the working directory as the declarations repository, nor a catalogue', async () => {
    const standing = await declarations()
    const project = await service()
    const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })

    // Standing in a declarations repository, a catalogue configured: neither
    // is init's. A request to the catalogue would throw (tests/setup/offline.ts).
    const { code, err } = await run(['init', '--project', project, ...TYPED_FLAGS], client, undefined, {
      cwd: standing,
      env: { IDP_BACKSTAGE_URL: 'http://127.0.0.1:9', IDP_BACKSTAGE_TOKEN: 'dummy' },
    })

    expect(code).toBe(0)
    expect(err).toContain('no declarations repository found')
    expect(err).not.toContain('reading the declarations repository')
    expect(err).not.toContain('127.0.0.1')
    expect(summaryOf(openingOf(requestsOf(client, 'architect')[0]))).toContain('  entities: 0')
  })

  it('refuses a broken IDP_REPO or config.yml repo before any model, naming no --repo', async () => {
    const project = await service()
    const xdg = await temp()
    const file = path.join(xdg, 'idp-agent', 'config.yml')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `repo: ${path.join(xdg, 'missing')}\n`, 'utf8')
    const cases: Array<{ what: string; repo?: string; env?: Record<string, string>; says: string }> = [
      { what: 'not a directory', repo: path.join(xdg, 'missing'), says: 'is not a directory' },
      { what: 'relative', repo: 'iac', says: 'is relative' },
      { what: 'config.yml', env: { XDG_CONFIG_HOME: xdg }, says: 'is not a directory' },
    ]
    for (const one of cases) {
      const client = scripted({ inspector: INSPECTING, architect: [PROPOSING], reviewer: [OK] })
      const { code, err } = await run(['init', '--project', project, ...TYPED_FLAGS], client, one.repo, {
        ...(one.env === undefined ? {} : { env: one.env }),
      })
      expect(code, one.what).toBe(2)
      expect(client.seen, one.what).toEqual([])
      expect(err, one.what).toContain(one.says)
      expect(err, one.what).not.toContain('--repo')
    }
  })
})
