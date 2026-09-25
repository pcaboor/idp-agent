import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS, HELP, main, parseArguments } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { PLAN_LIMITS } from '../../src/core/schemas/plan.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import { hashTree } from '../support/tree.js'

/**
 * `idpa "<phrase>"`, the one gesture (§7.4): from anywhere, a question about
 * the SI or an intent to change it, and the Supervisor decides which. A
 * question is answered as `ask` answers it; a change is previewed as
 * `plan "<intent>"` previews it — against the declarations repository found
 * the way every command finds it, and with the Inspector only when there is an
 * application repository to inspect.
 */

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return (
        turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      )
    },
  }
}

const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const agentsOf = (client: { seen: GenerateRequest[] }): AgentName[] => [
  ...new Set(client.seen.map((request) => request.agent)),
]

const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-entry-'))

/** The declarations repository, exactly as `init platform` leaves one. */
const scaffolded = async (folder = 'IaC'): Promise<string> => {
  const repo = path.join(await temp(), folder)
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return repo
}

/** An application repository: a package manifest at its root, and a marker. */
const application = async (marker = 'billing-api.marker'): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8' } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, marker), 'x\n', 'utf8')
  return root
}

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [{ name: 'pg', type: 'database' }],
}

const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const CREATE_DATABASE = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

const CREATE_ACCESS = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access',
      access: 'read',
      owner: 'group:default/tiger',
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
}

const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : undefined

/** A change request, drafted and accepted; the Inspector reports if it is asked. */
const changing = (): LlmClient & { seen: GenerateRequest[] } =>
  scripted({
    supervisor: [saying('MUTATION')],
    inspector: [turnCalling('list_files', {}), turnCalling(REPORT_TOOL, FACTS)],
    architect: [turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })],
    reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
  })

/** The events on the renderer a real run uses, on `err`: the lines a person reads. */
const run = async (args: string[], deps: Parameters<typeof main>[1] = {}) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

const SKIPPED = (reason: string): string =>
  `no application repository in the current directory (${reason}); drafting from the ` +
  'catalogue alone — --project <dir> inspects a service'

describe('parseArguments: a phrase where a command would be', () => {
  it.each([
    [['quels', 'services', 'utilisent', 'billing-db', '?'], 'quels services utilisent billing-db ?'],
    [['which databases are in prod?'], 'which databases are in prod?'],
    [['give billing-api read access to orders-db', 'in', 'prod'], 'give billing-api read access to orders-db in prod'],
    // A single word far from every command name is a phrase all the same.
    [['billing-db-prod'], 'billing-db-prod'],
  ])('reads %j as the phrase', (argv, phrase) => {
    expect(parseArguments(argv)).toStrictEqual({ name: 'entry', phrase, json: false })
  })

  it('passes --repo, --demo, --project and --json through, wherever they stand', () => {
    expect(parseArguments(['--repo', 'iac', 'which', 'databases?'])).toStrictEqual({
      name: 'entry',
      phrase: 'which databases?',
      repo: 'iac',
      json: false,
    })
    expect(parseArguments(['which databases?', '--demo'])).toStrictEqual({
      name: 'entry',
      phrase: 'which databases?',
      demo: true,
      json: false,
    })
    expect(
      parseArguments(['give billing-api read access', '--project', 'svc', '--json']),
    ).toStrictEqual({
      name: 'entry',
      phrase: 'give billing-api read access',
      project: 'svc',
      json: true,
    })
  })

  it('still reads a command name as the command', () => {
    expect(parseArguments(['graph'])).toStrictEqual({ name: 'graph', options: {} })
    expect(parseArguments(['ask', 'which databases?']).name).toBe('ask')
    expect(parseArguments(['plan', 'declare a database']).name).toBe('plan')
  })

  it.each([
    ['grpah', 'graph'],
    ['shwo', 'show'],
    ['palm', 'plan'],
    ['Graph', 'graph'],
    ['valdiate', 'validate'],
  ])('suggests the command %s is close to, rather than sending it to a model', (typed, meant) => {
    expect(parseArguments([typed])).toStrictEqual({
      name: 'error',
      message: `unknown command "${typed}"; did you mean ${meant}? To ask something, write a sentence`,
    })
  })

  it('second-guesses nothing but one word', () => {
    expect(parseArguments(['grpah', 'the', 'prod', 'databases']).name).toBe('entry')
  })

  it.each(['who', 'now', 'it', 'in', 'edit', 'as', 'asks', 'task', 'clean', 'hello'])(
    'reads %s as a phrase: an ordinary word is no slip',
    (word) => {
      expect(parseArguments([word])).toStrictEqual({ name: 'entry', phrase: word, json: false })
    },
  )

  it.each([
    [['--demo', 'graph'], 'graph', '--demo'],
    [['--repo', 'iac', 'show', 'billing-api'], 'show', '--repo'],
    [['--json', 'plan', 'declare a database'], 'plan', '--json'],
    [['--repo', 'iac', 'ask', 'which databases?'], 'ask', '--repo'],
  ])('refuses %j: options go after the command', (argv, name, option) => {
    expect(parseArguments(argv)).toStrictEqual({
      name: 'error',
      message: `options go after the command: idpa ${name} … ${option}`,
    })
  })

  it('sends nothing to a model for a command behind its options', async () => {
    const client = scripted({})
    const { code, err } = await run(['--repo', await temp(), 'show', 'billing-api'], {
      client,
      env: {},
      cwd: await temp(),
    })
    expect(code).toBe(2)
    expect(err).toContain('options go after the command: idpa show … --repo')
    expect(client.seen).toEqual([])
  })

  it('knows every command HELP lists, and reads none of them as a phrase', () => {
    for (const name of COMMANDS) {
      const parsed = parseArguments([name])
      expect(parsed.name).not.toBe('entry')
      if (parsed.name === 'error') expect(parsed.message).not.toContain('unknown command')
    }
    const listed = [...HELP.matchAll(/^ {2}idp-agent (\S+)/gm)].map((match) => match[1])
    expect(listed.length).toBeGreaterThan(0)
    for (const name of listed) expect(COMMANDS).toContain(name)
  })

  it('refuses options with no phrase, with the usage', () => {
    expect(parseArguments(['--repo', 'iac'])).toMatchObject({
      name: 'error',
      message: expect.stringContaining('a question or an intent'),
    })
  })

  it('refuses a phrase longer than an intent may be', () => {
    expect(parseArguments(['x'.repeat(PLAN_LIMITS.maxIntentLength + 1)])).toMatchObject({
      name: 'error',
      message: expect.stringContaining(`${PLAN_LIMITS.maxIntentLength} characters`),
    })
  })

  it('refuses --repo with --demo, and an option it does not know', () => {
    expect(parseArguments(['which databases?', '--demo', '--repo', 'iac'])).toMatchObject({
      name: 'error',
      message: expect.stringContaining('--repo <directory> or --demo, never both'),
    })
    expect(parseArguments(['which databases?', '--wat']).name).toBe('error')
  })
})

describe('idpa <a word close to a command>', () => {
  it('exits 2 with the suggestion, and no model is chosen or called', async () => {
    const client = scripted({})
    const { code, out, err } = await run(['grpah'], { client, env: {}, cwd: await temp() })
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('unknown command "grpah"; did you mean graph?')
    expect(client.seen).toEqual([])
  })
})

describe('idpa "<phrase>" names itself in its refusals', () => {
  it('a --repo that is no directory', async () => {
    const client = scripted({})
    const { code, err } = await run(['which dbs are in prod', '--repo', '/nope/idp-entry'], {
      client,
      env: {},
      cwd: await temp(),
    })
    expect(code).toBe(2)
    expect(err).toContain('/nope/idp-entry is not a directory; idpa --repo names')
    expect(client.seen).toEqual([])
  })

  it('a --project that is no directory, whatever the source', async () => {
    const repo = await scaffolded()
    for (const env of [{ IDP_REPO: repo }, {}]) {
      const client = scripted({})
      const { code, err } = await run(['which dbs are in prod', '--project', '/nope/idp-entry'], {
        client,
        env,
        cwd: await temp(),
      })
      expect(code).toBe(2)
      expect(err).toContain('/nope/idp-entry is not a directory; idpa --project names')
      expect(client.seen).toEqual([])
    }
  })

  it('a --project that is a declarations repository, with only the demo SI to read', async () => {
    const project = await scaffolded('declarations')
    const client = scripted({})
    const { code, err } = await run(['which dbs are in prod', '--project', project], {
      client,
      env: {},
      cwd: await temp(),
    })
    expect(code).toBe(2)
    expect(err).toContain('declarations is a declarations repository')
    expect(client.seen).toEqual([])
  })
})

describe('idpa "<phrase>" with no model configured', () => {
  it('refuses as ask and plan do, exit 2, before any agent', async () => {
    const events: AgentEvent[] = []
    const { code, err } = await run(['which databases are in prod?'], {
      env: {},
      cwd: await temp(),
      events: (event) => void events.push(event),
    })
    expect(code).toBe(2)
    expect(err).toMatch(/no model configured/)
    expect(events).toEqual([])
  })
})

describe('idpa "<phrase>" on a question', () => {
  const QUESTION = 'which databases are in prod?'
  it.each([
    [
      'entities',
      [
        turnCalling('search_entities', { type: 'database', env: 'prod' }),
        turnCalling('answer', {
          outcome: 'entities',
          refs: ['resource:default/billing-db-prod', 'resource:default/orders-db-prod'],
        }),
      ],
      0,
    ],
    ['nothing', [turnCalling('answer', { outcome: 'nothing' })], 1],
    [
      'unanswerable',
      [turnCalling('answer', { outcome: 'unanswerable', reason: 'no cost data' })],
      3,
    ],
  ])('answers as ask does: %s', async (_, analyst, expected) => {
    const cwd = await temp()
    const turns = { supervisor: [saying('QUESTION')], analyst }
    const asked = await run(['ask', QUESTION], { client: scripted(turns), env: {}, cwd })
    const entry = scripted(turns)
    const phrased = await run([QUESTION], { client: entry, env: {}, cwd })

    expect(phrased.code).toBe(expected)
    expect(phrased.code).toBe(asked.code)
    expect(phrased.out).toBe(asked.out)
    expect(phrased.err).toBe(asked.err)
    // The same source line as ask, and the classification said once.
    expect(phrased.err).toMatch(/^reading the demo SI/)
    expect(phrased.err.match(/^· question$/gm)).toHaveLength(1)
    expect(agentsOf(entry)).toEqual(['supervisor', 'analyst'])
  })
})

describe('idpa "<phrase>" --json on a question', () => {
  it('says --json is for a change, and answers as ask does', async () => {
    const turns = {
      supervisor: [saying('QUESTION')],
      analyst: [turnCalling('answer', { outcome: 'nothing' })],
    }
    const { code, out, err } = await run(['which dbs are in prod', '--json'], {
      client: scripted(turns),
      env: {},
      cwd: await temp(),
    })
    expect(code).toBe(1)
    expect(out).toBe('No entity matches that question.\n')
    expect(err).toMatch(/^· question\n--json applies to a change; a question is answered as text$/m)
  })
})

describe('idpa "<phrase>" on a change', () => {
  it('from a directory that is no application repository: no Inspector, said, and a diff', async () => {
    const repo = await scaffolded()
    const standing = await temp()
    const before = await hashTree(repo)
    const client = changing()

    const { code, out, err } = await run([INTENT], {
      client,
      cwd: standing,
      env: { IDP_REPO: repo },
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(err).toMatch(/^· mutation$/m)
    expect(err).toContain('reading the declarations repository IaC (IDP_REPO)')
    expect(err).toContain(
      SKIPPED(`${path.basename(standing)} holds no catalog-info.yaml or package manifest at its root`),
    )
    expect(agentsOf(client)).toEqual(['supervisor', 'architect', 'reviewer'])
    expect(out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
    expect(await hashTree(repo)).toBe(before)
  })

  it('tells the Architect no application repository was inspected, and invents no fact', async () => {
    const repo = await scaffolded()
    const client = changing()

    await run([INTENT], {
      client,
      cwd: await temp(),
      env: { IDP_REPO: repo },
      ask: answering('read'),
    })

    const opening = openingOf(client.seen.find((request) => request.agent === 'architect'))
    expect(opening).toContain(`request: ${INTENT}\n\nrepository: not inspected\n`)
    expect(opening).not.toMatch(/^ {2}name: /m)
  })

  it('from inside a declarations repository, nothing configured: decides against it', async () => {
    const repo = await scaffolded()
    const before = await hashTree(repo)
    const client = changing()

    const { code, out, err } = await run([INTENT], {
      client,
      cwd: repo,
      env: {},
      ask: answering('read'),
    })

    expect(code).toBe(0)
    // Said before the Supervisor decides, so it names both roads: --demo is
    // for a question, and a change never reads the demo SI.
    expect(err).toMatch(
      /^reading the declarations repository IaC \(the current directory\); --repo <directory> reads another, --demo the fictional SI for a question$/m,
    )
    expect(err).toContain(SKIPPED('IaC is a declarations repository'))
    expect(agentsOf(client)).not.toContain('inspector')
    expect(out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
    expect(await hashTree(repo)).toBe(before)
  })

  it('from $HOME with a package manifest: not inspected, whatever it holds', async () => {
    const repo = await scaffolded()
    const home = await application('taxes.marker')
    const client = changing()

    const { code, err } = await run([INTENT], {
      client,
      cwd: home,
      env: { IDP_REPO: repo, HOME: home },
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(err).toContain(SKIPPED(`${path.basename(home)} is your home directory`))
    expect(agentsOf(client)).toEqual(['supervisor', 'architect', 'reviewer'])
  })

  it('from a folder inside the declarations repository holding a manifest: not inspected', async () => {
    const repo = await scaffolded()
    const scripts = path.join(repo, 'scripts')
    await mkdir(scripts)
    await writeFile(path.join(scripts, 'package.json'), '{"name":"tools"}\n', 'utf8')
    const client = changing()

    const { code, err } = await run([INTENT], {
      client,
      cwd: scripts,
      env: { IDP_REPO: repo },
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(err).toContain(SKIPPED('IaC/scripts is inside the declarations repository'))
    expect(agentsOf(client)).toEqual(['supervisor', 'architect', 'reviewer'])
  })

  it('from an application repository: the Inspector reads it', async () => {
    const repo = await scaffolded()
    const standing = await application('standing-here.marker')
    const client = changing()

    const { code, err } = await run([INTENT], {
      client,
      cwd: standing,
      env: { IDP_REPO: repo },
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(err).not.toContain('no application repository')
    expect(agentsOf(client)).toEqual(['supervisor', 'inspector', 'architect', 'reviewer'])
    const listed = JSON.stringify(
      client.seen.filter((request) => request.agent === 'inspector')[1]?.transcript,
    )
    expect(listed).toContain('standing-here.marker')
  })

  it('with --project: inspects the directory it names', async () => {
    const repo = await scaffolded()
    const project = await application('named.marker')
    const client = changing()

    const { code } = await run([INTENT, '--project', project, '--repo', repo], {
      client,
      cwd: await temp(),
      env: {},
      ask: answering('read'),
    })

    expect(code).toBe(0)
    const listed = JSON.stringify(
      client.seen.filter((request) => request.agent === 'inspector')[1]?.transcript,
    )
    expect(listed).toContain('named.marker')
  })

  it('with --project naming a declarations repository: exit 2, before any model', async () => {
    const repo = await scaffolded()
    const project = await scaffolded('declarations')
    const client = changing()

    const { code, err } = await run([INTENT, '--project', project], {
      client,
      cwd: await temp(),
      env: { IDP_REPO: repo },
    })

    expect(code).toBe(2)
    expect(err).toContain('idpa --project names the application repository')
    expect(err).toContain('declarations is a declarations repository')
    expect(client.seen).toEqual([])
  })

  it('--json reaches the plan road', async () => {
    const repo = await scaffolded()
    const { code, out } = await run([INTENT, '--json'], {
      client: changing(),
      cwd: await temp(),
      env: { IDP_REPO: repo },
      ask: answering('read'),
    })
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ outcome: 'planned' })
  })

  it('with no declarations repository anywhere: refused, naming every way to name one', async () => {
    const client = changing()

    const { code, out, err } = await run([INTENT], { client, cwd: await temp(), env: {} })

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('needs a declarations repository')
    expect(err).toContain('--repo <directory>')
    expect(err).toContain('the current directory')
    expect(err).toContain('IDP_REPO')
    expect(err).toContain('config.yml')
    // Only the Supervisor ran: the demo SI is never a change's repository.
    expect(agentsOf(client)).toEqual(['supervisor'])
  })
})

describe('ask on a change request', () => {
  it('still declines it, and says which gesture previews it', async () => {
    const { code, err } = await run(['ask', INTENT], {
      client: scripted({ supervisor: [saying('MUTATION')] }),
      cwd: await temp(),
      env: {},
    })
    expect(code).toBe(3)
    expect(err).toContain('that is a change request; run it as idpa "<phrase>" to preview the plan')
  })
})
