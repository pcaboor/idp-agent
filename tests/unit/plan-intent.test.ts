import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main, renderEvent } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runIntent } from '../../src/cli/commands/plan.js'
import { reopening } from '../../src/cli/commands/submit.js'
import type { ForgeProvider } from '../../src/forge/provider.js'
import { CONFIG_FILE } from '../../src/cli/config.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import { hashBoth, hashTree } from '../support/tree.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import { confirmingEnvironment } from '../support/ask.js'
import { ForgeInputError } from '../../src/forge/errors.js'
import { clearedFor, clone, removeClones, scratch } from '../support/forge-fixture.js'
import { committed, git, observable, show } from '../support/git.js'

/**
 * Replays a scripted sequence of model turns, keyed by AGENT.
 *
 * Keyed rather than flat, unlike the one in `architect.test.ts`: this run
 * drives three agents in sequence, and a flat list makes every assertion depend
 * on how many turns the agent before it happened to spend. It keeps every
 * request, so a test can assert what each agent was told — which is the only
 * way to check that the Reviewer is handed the request and not the draft's
 * reasoning.
 *
 * No recording and no key: `tests/setup/offline.ts` replaces fetch with a
 * thrower, and nothing here would reach it anyway.
 */
const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      // Copied, not kept by reference: the agent loops go on pushing into the
      // very array they handed over, so a stored request would report the
      // transcript as it ended rather than as that turn saw it.
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return (
        turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      )
    },
  }
}

const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

/** The opening message of a request. Narrowed: a tool entry carries no text. */
const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-intent-'))

/** The declarations repository, exactly as `init platform` leaves one. */
const scaffoldedRepository = async (): Promise<string> => {
  const repo = path.join(await temp(), 'iac')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return repo
}

/** The APPLICATION repository the Inspector reads (§7.4, step 3). */
const application = async (config?: string): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8' } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '* @acme/platform\n', 'utf8')
  if (config !== undefined) await writeFile(path.join(root, CONFIG_FILE), config, 'utf8')
  return root
}

const CONFIGURED = `iacRepo: github.com/acme/iac
environments: [dev, staging, prod]
`

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [{ name: 'pg', type: 'database' }],
}

/**
 * Every value is either in the request or already in the repository — which is
 * what a signed plan means. Against a freshly scaffolded repository the
 * vocabulary is empty, so the request has to carry all of it.
 */
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
      type: 'database-access', access: 'read',
      owner: 'group:default/tiger',
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
}

const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'
const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

/** Inspector reports, Architect proposes, Reviewer accepts. One turn each. */
const converging = (operations: unknown[]): LlmClient & { seen: GenerateRequest[] } =>
  scripted({
    inspector: [turnCalling(REPORT_TOOL, FACTS)],
    architect: [turnCalling(PROPOSE_TOOL, { operations })],
    reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
  })

/**
 * Answers the one question a grant now always carries, and declines the rest.
 *
 * A level is asked, never read out of the request, so a fixture that wants a
 * complete plan has to answer for it — which is what a person does. So is an
 * environment nobody pointed at, and it is confirmed as the draft proposed it
 * (`confirmingEnvironment`). Every other question is left unanswered, so a
 * test about an unvouched owner still tests that.
 */
const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : confirmingEnvironment(question)
describe('plan "<intent>"', () => {
  it('leaves the declarations repository byte-identical', async () => {
    // "Preview only — writes nothing" is the whole stage, and the intent form
    // is the path that now reaches a model. Not a claim: a hash of every path,
    // every byte and every directory either side of a full run.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
    })

    expect(result.found).toBe(true)
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('leaves the application repository byte-identical too', async () => {
    // The Inspector reads it, and reading is all it does. A snapshot is taken
    // before any agent runs and nothing downstream holds a path into it.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashTree(project)

    await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
    })

    expect(await hashTree(project)).toBe(before)
  })

  it('ends on the diff the --from form renders, and on §7.4’s line', async () => {
    // The same renderer, reached by a different road. A second one would be a
    // second answer to "what would this do?".
    const repo = await scaffoldedRepository()
    const project = await application()

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
    })

    expect(result.found).toBe(true)
    expect(result.text).toContain('--- /dev/null')
    expect(result.text).toContain(`+++ b/${DATABASE_PATH}`)
    expect(result.text).toContain(`+++ b/${ACCESS_PATH}`)
    expect(result.text).toContain('+  name: orders-db-prod')
    expect(result.text.trimEnd().endsWith(CLOSING)).toBe(true)
  })

  it('counts what was already wrong elsewhere, names the repository, and asks nobody to fix it', async () => {
    // The intent road renders through the same preview, and has to hand it the
    // repository as the user named it, or the line names a command nobody can run.
    const repo = await scaffoldedRepository()
    const legacy = 'catalog/databases/legacy.yml'
    await mkdir(path.join(repo, 'catalog', 'databases'), { recursive: true })
    await writeFile(
      path.join(repo, ...legacy.split('/')),
      '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: legacy\n',
      'utf8',
    )
    const project = await application()
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    const result = await runIntent({
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client,
      emit: collect().emit,
    })

    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${DATABASE_PATH}`)
    expect(result.text).toContain(
      `1 error already in the repository, in files this plan does not touch — ` +
        `idp-agent validate ${repo} lists them`,
    )
    // One Architect turn: the standing error failed no attempt.
    expect(client.seen.filter((request) => request.agent === 'architect')).toHaveLength(1)
  })

  it('does not tell the Architect a reference to a set-aside document is dangling', async () => {
    // A System the repository declares is read and not modelled: it exists.
    // Counted as dangling, the summary the Architect reads called the
    // repository broken where `validate` does not. An API is read and never
    // proposed: a change is decided against the write model, where it is a
    // reference that resolves, as it was when it was set aside too.
    const repo = await scaffoldedRepository()
    await mkdir(path.join(repo, 'catalog', 'apis'), { recursive: true })
    await writeFile(
      path.join(repo, 'catalog', 'apis', 'billing-events.yml'),
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: API',
        'metadata:',
        '  name: billing-events',
        'spec:',
        '  type: asyncapi',
        '  lifecycle: production',
        '  owner: group:default/tiger',
        '  definition: "asyncapi: 3.0.0"',
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: System',
        'metadata:',
        '  name: events',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(repo, 'catalog', 'databases', 'events-db-prod.yml'),
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: events-db-prod',
        '  annotations:',
        '    company.fr/env: prod',
        'spec:',
        '  type: database',
        '  owner: group:default/tiger',
        '  dependsOn:',
        '    - api:default/billing-events',
        '    - system:default/events',
        '',
      ].join('\n'),
      'utf8',
    )
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    await runIntent({
      ask: answering('read'),
      intent: INTENT,
      repo,
      project: await application(),
      client,
      emit: collect().emit,
    })

    const opening = openingOf(client.seen.find((request) => request.agent === 'architect'))
    expect(opening).toContain('dangling references: 0')
    // And the API is no node of the graph the Architect is summarised.
    expect(opening).toMatch(/kinds: Resource\n/)
  })

  it('tells the Architect of no dangling providesApis, nor of an API set aside in its namespace', async () => {
    // A change is decided against the write model, which declares neither an
    // API nor what provides one: a service providing an API declared in some
    // other repository — the common case in a real catalogue — is no broken
    // reference to the Architect, as it was not when the field was dropped.
    // validate reports it; the summary the Architect reads does not.
    const repo = await scaffoldedRepository()
    await mkdir(path.join(repo, 'catalog', 'apis'), { recursive: true })
    await writeFile(
      path.join(repo, 'catalog', 'apis', 'billing.yml'),
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: API',
        'metadata:',
        '  name: billing',
        '  namespace: payments',
        'spec:',
        '  type: openapi',
        '  lifecycle: production',
        '  owner: group:payments/tiger',
        '  definition: "openapi: 3.1.0"',
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: billing-api',
        'spec:',
        '  type: service',
        '  lifecycle: production',
        '  owner: group:default/tiger',
        '  providesApis:',
        '    - payments/billing',
        '    - ghost',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(repo, 'catalog', 'databases', 'events-db-prod.yml'),
      [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: events-db-prod',
        '  annotations:',
        '    company.fr/env: prod',
        'spec:',
        '  type: database',
        '  owner: group:default/tiger',
        '  dependsOn:',
        '    - api:payments/billing',
        '',
      ].join('\n'),
      'utf8',
    )
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    await runIntent({
      ask: answering('read'),
      intent: INTENT,
      repo,
      project: await application(),
      client,
      emit: collect().emit,
    })

    const opening = openingOf(client.seen.find((request) => request.agent === 'architect'))
    expect(opening).toContain('dangling references: 0')
    expect(opening).toMatch(/kinds: Component, Resource\n/)
  })

  it('hands the Reviewer the original request, and nothing the Architect saw', async () => {
    // `reviewer.ts` makes this the whole point of its input list: the Architect
    // and the Reviewer are the same weights behind the same provider, so a
    // second opinion fed the first one's reasoning is an echo holding a veto.
    const repo = await scaffoldedRepository()
    const project = await application()
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    await runIntent({
      intent: INTENT,
      repo,
      project,
      client,
      emit: collect().emit,
      ask: answering('read'),
    })

    const review = client.seen.find((request) => request.agent === 'reviewer')
    expect(review?.transcript[0]?.role).toBe('user')
    expect(openingOf(review)).toContain(`request: ${INTENT}`)
    // Not the facts, not the catalogue summary, not which attempt this is.
    expect(openingOf(review)).not.toContain('repository:')
    expect(openingOf(review)).not.toContain('si:')
    expect(review?.transcript).toHaveLength(1)
  })

  it('asks rather than guesses, and never pays for a review of a question', async () => {
    // A value only the user holds. The signer turns it into a question and the
    // loop leaves before the first gate that costs a round-trip (§6.1).
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const client = converging([CREATE_DATABASE])

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: 'declare the database orders-db-prod in prod',
      repo,
      project,
      client,
      emit: collect().emit,
    })

    expect(await hashBoth(repo, project)).toBe(before)
    expect(result.unsupported).toBe(true)
    expect(result.found).toBe(false)
    expect(result.text).toContain('operations.0.entity.spec.owner')
    expect(result.text).not.toContain('@@')
    expect(client.seen.some((request) => request.agent === 'reviewer')).toBe(false)
  })

  it('stops after three attempts, showing the partial plan and the reason', async () => {
    // §6.1 and §7.5: three attempts, then a clean stop — the partial plan, the
    // reason, and no file. Not a crash and not a plan.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const rejected = turnCalling(VERDICT_TOOL, {
      verdict: 'reject',
      reason: 'the request named no cache, and this plan declares one',
    })
    const proposed = turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })
    const client = scripted({
      inspector: [turnCalling(REPORT_TOOL, FACTS)],
      architect: [proposed, proposed, proposed],
      reviewer: [rejected, rejected, rejected],
    })

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client,
      emit: collect().emit,
    })

    expect(await hashBoth(repo, project)).toBe(before)
    expect(result.found).toBe(false)
    // Not `unsupported`: this build understood the request and acted on it.
    // It is a negative answer about this plan, not a boundary of the tool.
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('3 attempts')
    expect(result.text).toContain('reviewer')
    expect(result.text).toContain('the request named no cache')
    expect(result.text).toContain('orders-db-prod')
    expect(result.text).not.toContain('@@')
    expect(result.text).not.toContain(CLOSING)
  })

  it('makes every agent audible on the stream', async () => {
    // Design §6.2. The CLI draws none of this yet; the stream is what stage 7
    // renders, and the tests consume the same one.
    const repo = await scaffoldedRepository()
    const project = await application()
    const { events, emit } = collect()

    await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit,
    })

    const started = events.filter((event) => event.type === 'agent:start').map((e) => e.agent)
    expect(started).toEqual(['inspector', 'architect', 'reviewer'])
    expect(events.some((event) => event.type === 'plan:ready')).toBe(true)
  })
})

describe('plan "<intent>" and .idp-agent.yml', () => {
  it('runs without one: the vocabulary falls back to what the entities show', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client,
      emit: collect().emit,
    })

    expect(result.found).toBe(true)
    const draft = client.seen.find((request) => request.agent === 'architect')
    // A freshly scaffolded repository holds no entity, so it declares no
    // environment — which is exactly the state §7.0 exists to fix.
    expect(openingOf(draft)).toContain('environments: (none declared)')
  })

  it('seeds the vocabulary from the environments the file declares', async () => {
    const repo = await scaffoldedRepository()
    const project = await application(CONFIGURED)
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client,
      emit: collect().emit,
    })

    expect(result.found).toBe(true)
    const draft = client.seen.find((request) => request.agent === 'architect')
    expect(openingOf(draft)).toContain('environments: dev, prod, staging')
  })

  it('refuses a malformed one, naming the field, before any agent runs', async () => {
    // A committed file that does not parse is not a repository that declared
    // nothing. Falling back would answer a typo with a run that silently asks
    // about everything, and charge a model for it.
    const repo = await scaffoldedRepository()
    const project = await application('iacRepo: github.com/acme/iac\nenvironments: prod\n')
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    await expect(
      runIntent({ intent: INTENT, repo, project, client, emit: collect().emit }),
    ).rejects.toThrow(/environments/)
    expect(client.seen).toEqual([])
  })
})

describe('plan "<intent>" through main', () => {
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

  it('exits 0 on a plan it could draft', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()

    const { code, out } = await run(['plan', INTENT, '--repo', repo], {
      ask: answering('read'),
      cwd: project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      env: {},
    })

    expect(code).toBe(0)
    expect(out).toContain(`+++ b/${DATABASE_PATH}`)
    // No escape code: an injected `out` is a sink, not a terminal.
    expect(out).not.toContain('[')
  })

  it('exits 3 when it has a question, which is understood and not acted on', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()

    const { code, out } = await run(
      ['plan', 'declare the database orders-db-prod in prod', '--repo', repo],
      { cwd: project, client: converging([CREATE_DATABASE]), env: {} },
    )

    expect(code).toBe(3)
    expect(out).toContain('operations.0.entity.spec.owner')
  })

  it('exits 1 when the loop did not converge, which is a negative answer', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()
    const rejected = turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: 'not what was asked' })
    const proposed = turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })

    const { code, out } = await run(['plan', INTENT, '--repo', repo], {
      ask: answering('read'),
      cwd: project,
      env: {},
      client: scripted({
        inspector: [turnCalling(REPORT_TOOL, FACTS)],
        architect: [proposed, proposed, proposed],
        reviewer: [rejected, rejected, rejected],
      }),
    })

    expect(code).toBe(1)
    expect(out).toContain('3 attempts')
  })

  it('refuses a run with no model configured, in providers.ts’s own words', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()

    const { code, err } = await run(['plan', INTENT, '--repo', repo], { cwd: project, env: {} })

    expect(code).toBe(2)
    expect(err).toContain('no model configured: set IDP_PROVIDER (one of ')
    expect(err).toContain('IDP_MODEL')
  })

  it('refuses a malformed .idp-agent.yml with the argument-error code', async () => {
    const repo = await scaffoldedRepository()
    const project = await application('iacRepo: [unclosed\n')

    const { code, err } = await run(['plan', INTENT, '--repo', repo], {
      ask: answering('read'),
      cwd: project,
      env: {},
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
    })

    expect(code).toBe(2)
    expect(err).toContain(CONFIG_FILE)
  })

  it('still needs the repository a preview is decided against', async () => {
    const { code, err } = await run(['plan', INTENT], { env: {} })
    expect(code).toBe(2)
    expect(err).toContain('--repo')
  })

  it('writes progress to stderr, so stdout stays the diff a pipe reads', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()

    const { out, err } = await run(['plan', INTENT, '--repo', repo], {
      ask: answering('read'),
      cwd: project,
      env: {},
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
    })

    expect(err).toContain('inspector')
    expect(err).toContain('architect')
    expect(err).toContain('reviewer')
    expect(out).not.toContain('inspector')
  })
})

describe('plan "<intent>" --submit', () => {
  // Every repository here is a real one: removed at the end, a small disk fills.
  afterAll(async () => {
    await removeClones()
    await Promise.all(applications.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** The application repository the Inspector reads, removed with the clones. */
  const applications: string[] = []
  const inspected = async (): Promise<string> => {
    const root = await application()
    applications.push(root)
    return root
  }

  const branches = async (repo: string): Promise<string[]> =>
    (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/idp-agent/'))
      .split('\n')
      .filter((line) => line !== '')

  /** One run of the intent road with `--submit`, on the scripted client it is handed. */
  const submitting = async (
    repo: string,
    client: LlmClient,
    extra: Partial<Parameters<typeof runIntent>[0]> = {},
  ) =>
    runIntent({
      intent: INTENT,
      repo,
      project: await inspected(),
      client,
      emit: collect().emit,
      ask: answering('read'),
      submit: {},
      ...extra,
    })

  it('cuts the branch the same plan cuts by --from, after all five gates', async () => {
    const repo = await clone()
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])
    const main0 = await git(repo, 'rev-parse', 'main')
    // Asked for no confirmation by default; one is injected here only to see
    // what had run by the time the submission was put to a person.
    const before: string[] = []

    const result = await submitting(repo, client, {
      submit: {
        confirm: async () => {
          before.push(...client.seen.map((request) => request.agent))
          return true
        },
      },
    })

    expect(result.found).toBe(true)
    expect(result.text).toMatch(
      /2 files · submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched/,
    )
    // The Reviewer is the fifth gate on this road (ADR-0010), and it judged
    // the plan before anyone was asked to submit it.
    expect(before.at(-1)).toBe('reviewer')
    // The engine names the branch from the bytes: the plan `--from` clears
    // over the same repository is the same branch, whoever drafted it.
    const cut = await branches(repo)
    expect(cut).toEqual([(await clearedFor(repo)).branch])
    expect(await git(repo, 'rev-parse', 'main')).toBe(main0)
    expect(await show(repo, cut[0] ?? '', DATABASE_PATH)).toContain('name: orders-db-prod')
  })

  it('refuses a divergent repository before a single model call', async () => {
    // Three paid round-trips for a diff that cannot be submitted is the cost
    // this ordering removes: the check runs before the Inspector.
    const repo = await clone()
    await writeFile(path.join(repo, 'catalog', 'databases', 'stray.yml'), '# stray\n', 'utf8')
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])
    const before = await observable(repo)

    const result = await submitting(repo, client)

    expect(result.found).toBe(false)
    expect(result.text).toContain('stray.yml')
    expect(result.text).not.toContain('+++ b/')
    expect(client.seen).toEqual([])
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a divergent repository in --json with only the submission key, and no model call (D11)', async () => {
    const repo = await clone()
    await writeFile(path.join(repo, 'catalog', 'databases', 'stray.yml'), '# stray\n', 'utf8')
    const client = converging([CREATE_DATABASE, CREATE_ACCESS])

    const result = await submitting(repo, client, { json: true })

    expect(result.found).toBe(false)
    const report = JSON.parse(result.text) as Record<string, unknown>
    expect(Object.keys(report)).toEqual(['submission'])
    expect(report['submission']).toEqual({
      outcome: 'refused',
      reasons: [expect.stringContaining('catalog/databases/stray.yml')],
    })
    expect(client.seen).toEqual([])
  })

  it('refuses a repository that cannot take a branch as an argument, before a single model call', async () => {
    // Each is exit 2 at the CLI (`ForgeInputError`): not a clone, a folder of
    // one, nobody to commit as, a detached HEAD. Found by the forge as it
    // opens, before the snapshot is taken and long before the Inspector.
    const plain = await scaffoldedRepository()
    applications.push(path.dirname(plain))
    const outer = await scratch('idp-intent-outer-')
    await runInitPlatform({ root: path.join(outer, 'iac'), owner: '@acme/platform', version: '0.0.0-test' })
    await committed(outer)
    const anonymous = await clone()
    await git(anonymous, 'config', 'user.name', '')
    await git(anonymous, 'config', 'user.email', '')
    const detached = await clone()
    await git(detached, 'checkout', '-q', '--detach')

    for (const [repo, said] of [
      [plain, /not a git working tree/],
      [path.join(outer, 'iac'), /not at its root/],
      [anonymous, /identity/],
      [detached, /detached/],
    ] as const) {
      const client = converging([CREATE_DATABASE, CREATE_ACCESS])
      await expect(submitting(repo, client)).rejects.toThrow(ForgeInputError)
      await expect(submitting(repo, client)).rejects.toThrow(said)
      expect(client.seen).toEqual([])
    }
  })

  it('cuts no branch when the Reviewer refuses: the submission comes after it', async () => {
    const repo = await clone()
    const rejected = turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: 'not what was asked' })
    const proposed = turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })
    const before = await observable(repo)

    const result = await submitting(
      repo,
      scripted({
        inspector: [turnCalling(REPORT_TOOL, FACTS)],
        architect: [proposed, proposed, proposed],
        reviewer: [rejected, rejected, rejected],
      }),
      {
        submit: {
          confirm: async () => {
            throw new Error('a plan the Reviewer refused was put to a person')
          },
        },
      },
    )

    expect(result.found).toBe(false)
    expect(result.text).toContain('3 attempts')
    expect(await branches(repo)).toEqual([])
    expect(await observable(repo)).toBe(before)
  })

  it('submits a plan whose environment was answered at the prompt, not named', async () => {
    // An environment is never read from the request's words (2026-09-27): the
    // provenance holds the answer at its path, and the clearance re-runs the
    // policies against the provenance the plan was signed with (D1).
    const repo = await clone()
    const asked: string[] = []

    const result = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), {
      // Every value named but the environment, which nothing in the words says.
      intent:
        'declare the database orders-db-prod owned by group:default/tiger, then give ' +
        'component:default/billing-api a database-access granting read to resource:default/orders-db-prod',
      ask: async (question) => {
        asked.push(question.path)
        return answering('read')(question)
      },
    })

    expect(result.found).toBe(true)
    expect(asked.some((one) => one.endsWith('.metadata.env'))).toBe(true)
    expect(result.text).toMatch(/submitted as idp-agent\//)
    expect(await branches(repo)).toHaveLength(1)
  })

  it('reports the submission in --json under the key --from pins, and never prompts there (D11)', async () => {
    const repo = await clone()

    const result = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), {
      json: true,
      submit: {
        confirm: async () => {
          throw new Error('a --json run asked a person')
        },
      },
    })

    expect(result.found).toBe(true)
    const report = JSON.parse(result.text) as { outcome: string; submission: Record<string, unknown> }
    expect(report.outcome).toBe('planned')
    expect(Object.keys(report.submission).sort()).toEqual(['base', 'branch', 'commit', 'outcome'])
    expect(report.submission['outcome']).toBe('created')
    expect(report.submission['commit']).toBe(
      await git(repo, 'rev-parse', String(report.submission['branch'])),
    )
    expect(report.submission['base']).toEqual({ branch: 'main', commit: await git(repo, 'rev-parse', 'main') })
  })

  it('answers `unchanged` in --json for a plan the repository already holds, as --from does (D11)', async () => {
    const repo = await clone()
    const created = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), { json: true })
    const branch = (JSON.parse(created.text) as { submission: { branch: string } }).submission.branch
    // Merged: the repository now says it, and there is nothing to submit.
    await git(repo, 'merge', '-q', '--ff-only', branch)

    const result = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), { json: true })

    expect(result.found).toBe(true)
    expect(result.unsupported).toBeUndefined()
    const report = JSON.parse(result.text) as { outcome: string; submission: unknown }
    expect(report.outcome).toBe('planned')
    expect(report.submission).toEqual({ outcome: 'unchanged' })
    expect(await branches(repo)).toEqual([branch])
  })

  it('refuses, and cuts nothing, when main moves while the person answers', async () => {
    // §4.4: the repository is checked again at the moment of writing. The
    // base was read before the Inspector; a commit landing while a question
    // is open is the repository moving under a plan judged against the old one.
    const repo = await clone()
    let asked = 0

    const result = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), {
      ask: async (question) => {
        asked += 1
        await git(repo, 'commit', '-q', '--allow-empty', '-m', 'landed meanwhile')
        return answering('read')(question)
      },
    })

    expect(asked).toBeGreaterThan(0)
    expect(result.found).toBe(false)
    expect(result.text).toMatch(/main moved from [0-9a-f]{7} to main@[0-9a-f]{7} since the plan was read/)
    expect(await branches(repo)).toEqual([])
  })

  it('hands the forge main opened only to the repository it was opened on', async () => {
    // `main` opens the forge before the model is configured and hands it to
    // `runIntent`, which opens it again from a root of its own. If the two
    // roots ever disagreed, the confirmation would name one directory while
    // the branch was cut in another; an opener that checks makes that an error.
    const forge = {} as ForgeProvider
    const open = reopening(forge, '/somewhere/iac', 'declarations')

    await expect(open('/somewhere/iac', 'declarations')).resolves.toBe(forge)
    await expect(open('/somewhere/else', 'declarations')).rejects.toThrow(/another repository/)
    await expect(open('/somewhere/iac', 'service')).rejects.toThrow(/another repository/)
  })

  it('declined at the prompt: not submitted, nothing written', async () => {
    const repo = await clone()
    const before = await observable(repo)

    const result = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), {
      submit: { confirm: async () => false },
    })

    expect(result.found).toBe(true)
    expect(result.text).toContain('not submitted · nothing written')
    expect(await observable(repo)).toBe(before)
  })

  it('leaves the application repository byte-identical while submitting', async () => {
    const repo = await clone()
    const project = await inspected()
    const before = await hashTree(project)

    await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), { project })

    expect(await hashTree(project)).toBe(before)
  })

  it('prints stage 4’s preview over a clone without --submit, and writes nothing, .git included', async () => {
    const plain = await scaffoldedRepository()
    applications.push(path.dirname(plain))
    const repo = await clone()
    const before = await hashTree(repo)
    const run = (root: string) =>
      runIntent({
        intent: INTENT,
        repo: root,
        project: undefined,
        client: converging([CREATE_DATABASE, CREATE_ACCESS]),
        emit: collect().emit,
        ask: answering('read'),
      })

    const overPlain = await run(plain)
    const overClone = await run(repo)

    expect(overClone.text).toBe(overPlain.text)
    expect(overClone.text).toContain('2 files · nothing written')
    expect(await hashTree(repo)).toBe(before)
  })
})

describe('plan "<intent>" --submit through main', () => {
  afterAll(removeClones)

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

  it('refuses a --repo that cannot take a branch before the model is configured, and calls none', async () => {
    // An argument is refused before the configuration is (`applicationRoot`'s
    // rule): with no model configured, the answer is still about the
    // repository, so nobody configures a key only to be told the directory
    // cannot take a branch — and no model is called, since none could be.
    const plain = path.join(await scratch('idp-intent-plain-'), 'iac')
    await runInitPlatform({ root: plain, owner: '@acme/platform', version: '0.0.0-test' })
    const outer = await scratch('idp-intent-outer-')
    await runInitPlatform({ root: path.join(outer, 'iac'), owner: '@acme/platform', version: '0.0.0-test' })
    await committed(outer)
    const anonymous = await clone()
    await git(anonymous, 'config', 'user.name', '')
    await git(anonymous, 'config', 'user.email', '')
    const detached = await clone()
    await git(detached, 'checkout', '-q', '--detach')
    const home = await scratch('idp-intent-home-')

    for (const [repo, said] of [
      [plain, 'not a git working tree'],
      [path.join(outer, 'iac'), 'not at its root'],
      [anonymous, 'identity'],
      [detached, 'HEAD is detached'],
    ] as const) {
      const before = await hashTree(repo)
      const { code, out, err } = await run(['plan', INTENT, '--repo', repo, '--submit'], {
        cwd: home,
        env: { HOME: home, XDG_CONFIG_HOME: home },
      })
      expect(code).toBe(2)
      expect(err).toContain(said)
      expect(err).not.toContain('no model configured')
      expect(out).toBe('')
      expect(await hashTree(repo)).toBe(before)
    }
  })

  it('cuts the branch on exit 0, and asks nobody when nobody is at a terminal', async () => {
    const repo = await clone()
    const project = await scratch('idp-intent-app-')
    await writeFile(path.join(project, 'package.json'), '{ "name": "billing-api" }\n', 'utf8')

    const { code, out } = await run(['plan', INTENT, '--repo', repo, '--submit'], {
      ask: answering('read'),
      cwd: project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      env: {},
    })

    expect(code).toBe(0)
    expect(out).toMatch(/submitted as idp-agent\/orders-db-prod-[0-9a-f]{8}/)
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
  })

  it('answers exit 1, not 2, and cuts nothing, when HEAD is detached while the person answers', async () => {
    // Detached when the run starts is an argument (exit 2, above); detached
    // DURING the run is the repository moving, which is a refusal (§4.4).
    const repo = await clone()
    const project = await scratch('idp-intent-app-')
    await writeFile(path.join(project, 'package.json'), '{ "name": "billing-api" }\n', 'utf8')
    let asked = 0

    const { code, out, err } = await run(['plan', INTENT, '--repo', repo, '--submit'], {
      ask: async (question) => {
        asked += 1
        await git(repo, 'checkout', '-q', '--detach')
        return answering('read')(question)
      },
      cwd: project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      env: {},
    })

    expect(asked).toBeGreaterThan(0)
    expect(code).toBe(1)
    expect(out + err).toContain('main changed during the run')
    expect(
      await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/'),
    ).toBe('')
  })

  it('refuses a divergent repository on exit 1, with no model call, in --json too', async () => {
    const repo = await clone()
    await writeFile(path.join(repo, 'catalog', 'databases', 'stray.yml'), '# stray\n', 'utf8')
    const project = await scratch('idp-intent-app-')
    await writeFile(path.join(project, 'package.json'), '{ "name": "billing-api" }\n', 'utf8')

    for (const json of [[], ['--json']]) {
      const client = converging([CREATE_DATABASE, CREATE_ACCESS])
      const { code, out } = await run(['plan', INTENT, '--repo', repo, '--submit', ...json], {
        ask: answering('read'),
        cwd: project,
        client,
        env: {},
      })
      expect(code).toBe(1)
      expect(out).toContain('stray.yml')
      expect(client.seen).toEqual([])
    }
  })
})

describe('what a run looks like on a terminal', () => {
  it('renders one line per event, and nothing for the two that are the answer', () => {
    // Stage 7 draws these with Ink. Until then the stream has to be legible as
    // a log: appended lines, no cursor movement, nothing that needs a TTY.
    expect(renderEvent({ type: 'agent:start', agent: 'architect' })).toBe('· architect')
    expect(renderEvent({ type: 'tool:call', id: 'c1', name: 'search_entities', args: { env: 'prod' } })).toBe(
      '  → search_entities',
    )
    expect(renderEvent({ type: 'tool:result', id: 'c1', name: 'search_entities', rows: 25, truncated: 3 })).toBe(
      '  ← 25 row(s) · 3 more not shown',
    )
    expect(renderEvent({ type: 'plan:ready', operations: 2 })).toBe('· a draft with 2 operation(s)')
    expect(
      renderEvent({ type: 'repair', attempt: 2, gate: 'policy', reason: 'environment-mismatch' }),
    ).toBe('  ! attempt 2 refused at the policy gate: environment-mismatch')
    expect(renderEvent({ type: 'retry', agent: 'architect', reason: 'spec.owner: invalid' })).toBe(
      '  ! architect corrected itself: spec.owner: invalid',
    )
    expect(renderEvent({ type: 'refused', agent: 'reviewer', reason: 'not asked for' })).toBe(
      '! reviewer refused: not asked for',
    )
    // The reason is the error the command prints next, on its own line: said
    // here too, it would reach the user twice.
    expect(renderEvent({ type: 'stopped', agent: 'inspector', reason: 'a timeout' })).toBe(
      '! inspector stopped',
    )
    expect(
      renderEvent({
        type: 'overridden',
        path: 'operations.0.entity.spec.owner',
        owner: 'group:default/lynx',
        determined: 'group:default/tiger',
        from: ['component:default/billing-api'],
      }),
    ).toBe(
      '  = operations.0.entity.spec.owner is group:default/lynx, as stated; ' +
        'component:default/billing-api would give group:default/tiger',
    )
    // An answer put back where a redraft left the question open, and named by
    // the entity it is about: the path it was typed at belongs to a plan the
    // user no longer sees.
    const reapplied = {
      type: 'reapplied',
      path: 'operations.1.entity.spec.owner',
      value: 'group:default/tiger',
      entity: 'resource:default/orders-db-prod',
      answeredAt: 'operations.0.entity.spec.owner',
    } as const
    expect(renderEvent(reapplied)).toBe(
      '  = operations.1.entity.spec.owner is group:default/tiger, ' +
        'as answered for resource:default/orders-db-prod',
    )
    // What the draft said instead is a model's, so it is one bounded line.
    expect(renderEvent({ ...reapplied, replaced: `group:default/lion\n${'x'.repeat(300)}` })).toBe(
      '  = operations.1.entity.spec.owner is group:default/tiger, ' +
        `as answered for resource:default/orders-db-prod; the draft said group:default/lion ${'x'.repeat(181)}…`,
    )
    // The questions and the answer ARE what the command prints, on stdout. A
    // stderr copy would state one fact twice.
    expect(
      renderEvent({ type: 'answer:ready', outcome: 'entities', refs: ['resource:default/x'] }),
    ).toBeUndefined()
    expect(
      renderEvent({ type: 'ask', question: { path: 'operations.0', question: 'which?' } }),
    ).toBeUndefined()
  })

  it('never lets a model-authored reason run past one line', () => {
    // A reason is written by a model and bounded at 8 192 characters. A
    // terminal line is not where an arbitrary string belongs; the outcome on
    // stdout carries the whole of it.
    const line = renderEvent({
      type: 'refused',
      agent: 'architect',
      reason: `first\nsecond ${'x'.repeat(500)}`,
    })

    expect(line).not.toContain('\n')
    // The cap is on the REASON, not on the line: the label in front of it is
    // the engine's own words and is not the thing that needs bounding.
    expect(line?.length).toBeLessThan(250)
    expect(line?.endsWith('…')).toBe(true)
  })

  it('emits the signed plan and everything that judged it, for a machine', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()

    const result = await runIntent({
      // A grant's level is asked, never read out of the request.
      ask: answering('read'),
      intent: INTENT,
      repo,
      project,
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      emit: collect().emit,
      json: true,
    })

    const report = JSON.parse(result.text) as {
      outcome: string
      plan: { intent: string }
      files: string[]
      policies: unknown[]
      questions: unknown[]
      attempts: { attempt: number; gates: string[] }[]
    }

    expect(result.found).toBe(true)
    expect(report.outcome).toBe('planned')
    expect(report.plan.intent).toBe(INTENT)
    expect(report.files).toEqual([DATABASE_PATH, ACCESS_PATH])
    // Empty, and stated: `repair` returns `planned` only once both gates ran
    // and found nothing, and a machine has to be able to tell that from a run
    // where they never ran at all.
    expect(report.policies).toEqual([])
    expect(report.questions).toEqual([])
    // The FIRST attempt stopped on the level, which is a question and not a
    // failed gate: it leaves after the free ones and pays for nothing. The
    // last attempt is the one that ran all five, and `attempts` carries both
    // because a machine reading this report has to see the round-trip the
    // question saved.
    expect(report.attempts[0]?.gates).toEqual(['zod', 'signature', 'policy'])
    expect(report.attempts.at(-1)?.gates).toEqual([
      'zod',
      'signature',
      'policy',
      'recheck',
      'reviewer',
    ])
    expect(result.text).not.toContain(CLOSING)
  })

  it('renders nothing for the events that only bound a span', () => {
    // An agent's end, an attempt's bounds and a gate that passed are structure
    // for a trace (src/trace/). The lines they bound already say what happened.
    expect(renderEvent({ type: 'agent:end', agent: 'architect', threw: false })).toBeUndefined()
    expect(renderEvent({ type: 'attempt:start', attempt: 1 })).toBeUndefined()
    expect(renderEvent({ type: 'attempt:end', attempt: 1 })).toBeUndefined()
    expect(renderEvent({ type: 'gate:passed', attempt: 1, gate: 'zod' })).toBeUndefined()
  })
})
