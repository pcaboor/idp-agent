import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main, renderEvent } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runIntent } from '../../src/cli/commands/plan.js'
import { reopening, type SubmissionSummary } from '../../src/cli/commands/submit.js'
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
import { committed, git, observable, show, stored } from '../support/git.js'
import { githubClone, moveGitHubBase, unprotect, type GitHubClone } from '../support/github-fixture.js'
import { memorySink, onlyTrace } from '../support/trace.js'
import { GITHUB_LIMITS } from '../../src/forge/github/limits.js'
import type { GhProcess } from '../../src/process/gh.js'

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

  it('answers a second submission before the confirmation, and writes nothing', async () => {
    // The owner's addition of 2026-09-29, on the intent road: the models run
    // and the level is asked — they decide the bytes, hence the branch — and
    // the branch already there is named without a [y/N].
    const repo = await clone()
    await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]))
    const [seen, objects] = [await observable(repo), await stored(repo)]
    let prompted = false

    const result = await submitting(repo, converging([CREATE_DATABASE, CREATE_ACCESS]), {
      submit: {
        confirm: async () => {
          prompted = true
          return true
        },
      },
    })

    expect(result.found).toBe(true)
    expect(prompted).toBe(false)
    expect(result.text).toMatch(/already submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} · nothing written/)
    expect(await observable(repo)).toBe(seen)
    expect(await stored(repo)).toBe(objects)
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
    expect(Object.keys(report.submission).sort()).toEqual(['base', 'branch', 'commit', 'outcome', 'pushed'])
    expect(report.submission['pushed']).toBe(false)
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
    const open = reopening({ forge, road: { kind: 'local', why: 'asked' } }, '/somewhere/iac', 'declarations')

    expect((await open('/somewhere/iac', 'declarations')).forge).toBe(forge)
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

// ------------------------------------------------- --submit to GitHub (6.3.1)

/**
 * Each run starts a dozen real git processes, a push over the fake ssh and
 * the read-back's waits on a push that fails: seconds alone, more beside the
 * rest of the suite.
 */
const PUSHING = 30_000

/**
 * Every gh call and every model call of one run, in the order they were made: what
 * "before any model" and "after the Reviewer" are checked on. The fake answers; this only
 * writes down what was asked of it.
 */
const watching = (clone: GitHubClone, inner: LlmClient) => {
  const log: string[] = []
  const gh: GhProcess = async (argv, options) => {
    log.push(`gh ${argv.join(' ')}`)
    return clone.gh.process(argv, options)
  }
  const client: LlmClient = {
    generate: async (request) => {
      log.push(`model ${request.agent}`)
      return inner.generate(request)
    },
  }
  return { log, gh, client }
}

/** `main` over the clone, its environment and its fake gh, unless `deps` says otherwise. */
const run = async (clone: GitHubClone, args: string[], deps: Parameters<typeof main>[1] = {}) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    env: clone.env,
    gh: clone.gh.process,
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** The idp-agent branches a repository holds, the clone's or GitHub's side. */
const ours = async (dir: string): Promise<string[]> =>
  (await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/'))
    .split('\n')
    .filter((line) => line !== '')

/**
 * Whom gh is logged in as where a test searches a prompt or a trace for the
 * login: `ada`, the fixture's default, is in every `metadata`.
 */
const LOGIN = 'canary-login-0e7a'

const submitting = (clone: GitHubClone, project: string, extra: string[] = []): string[] =>
  ['plan', INTENT, '--repo', clone.repo, '--project', project, '--submit', ...extra]

describe('plan "<intent>" --submit to GitHub', { timeout: PUSHING }, () => {
  afterAll(removeClones)

  it('opens a pull request after all five gates, and prints the URL the engine builds', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    const { code, out, err } = await run(clone, submitting(clone, project), {
      gh,
      client,
      ask: answering('read'),
    })

    expect(code, err).toBe(0)
    expect(err).toMatch(
      /^submitting to github\.com\/acme\/iac, into main \(origin, main's upstream\), as [A-Za-z0-9-]+ \(gh\)$/m,
    )
    expect(out).toMatch(
      /^2 files · submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched$/m,
    )
    expect(out).toContain('Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1')
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
    // The very commit the clone holds is the one GitHub holds: pushed, never rebuilt.
    const [ref] = await ours(clone.repo)
    expect(await ours(clone.bare)).toEqual([ref])
    expect(await git(clone.bare, 'rev-parse', ref ?? '')).toBe(await git(clone.repo, 'rev-parse', ref ?? ''))
    expect(log.filter((line) => line.startsWith('gh ') && line.includes('POST'))).toHaveLength(1)
  })

  it('reads the rules before the first model call, nothing of GitHub while the agents run, and the rules again after the Reviewer', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    await run(clone, submitting(clone, project), { gh, client, ask: answering('read') })

    const first = log.findIndex((line) => line.startsWith('model '))
    const reviewed = log.lastIndexOf('model reviewer')
    expect(first).toBeGreaterThan(0)
    // § 8 items 1 to 4 and the base level, before the Inspector.
    expect(log.slice(0, first).some((line) => /rules\/branches\/main\b/.test(line))).toBe(true)
    expect(log.slice(0, first).some((line) => /git\/ref\/heads\/main\b/.test(line))).toBe(true)
    // Nothing of GitHub is asked while a model is: every line between is a model call.
    expect(log.slice(first, reviewed + 1).every((line) => line.startsWith('model '))).toBe(true)
    // Step 8 and step 11 after the last model call, and the pull request last.
    expect(log.slice(reviewed + 1).filter((line) => /rules\/branches\/main\b/.test(line)).length).toBeGreaterThanOrEqual(2)
    expect(log.at(-1)).toMatch(/POST/)
  })

  it('writes nothing on either side before the Reviewer has answered', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])
    const seenAtReview: string[][] = []
    const client: LlmClient = {
      generate: async (request) => {
        if (request.agent === 'reviewer') seenAtReview.push([...(await ours(clone.repo)), ...(await ours(clone.bare))])
        return inner.generate(request)
      },
    }

    const { code } = await run(clone, submitting(clone, project), { client, ask: answering('read') })

    expect(code).toBe(0)
    expect(seenAtReview).toEqual([[]])
  })

  it('refuses at the moment of acting when the rules go while the Reviewer reads, and writes nothing on either side', async () => {
    // § 3 step 8: the preflight passed before the Inspector; the ruleset is removed while
    // the last model call runs. The re-check is what refuses, before the local ref.
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])
    const client: LlmClient = {
      generate: async (request) => {
        if (request.agent === 'reviewer') unprotect(clone.gh)
        return inner.generate(request)
      },
    }

    const { code, out } = await run(clone, submitting(clone, project), { client, ask: answering('read') })

    expect(code).toBe(1)
    expect(out).toContain('Nothing was written.')
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a base whose rules let the opener merge, exit 1, before a single model call', async () => {
    const clone = await githubClone()
    unprotect(clone.gh)
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])

    const { code, out } = await run(clone, submitting(clone, project), { client: inner, ask: answering('read') })

    expect(code).toBe(1)
    expect(out).toContain(
      "not submitted — nothing on github.com/acme/iac's main stops the person who would open this pull request from merging it:",
    )
    expect(out).toContain('Add a ruleset on main (Settings → Rules → Rulesets):')
    expect(inner.seen).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a clone that is not level with GitHub, exit 1, before a single model call', async () => {
    const clone = await githubClone()
    await moveGitHubBase(clone)
    const project = await application(CONFIGURED)
    const inner = converging([CREATE_DATABASE, CREATE_ACCESS])

    const { code, out } = await run(clone, submitting(clone, project), { client: inner, ask: answering('read') })

    expect(code).toBe(1)
    expect(out).toContain('bring them level (git pull), then run this again.')
    expect(inner.seen).toEqual([])
  })

  it.each([
    ['gh not logged in', (clone: GitHubClone) => clone.gh.logout(), 'gh is not logged in to github.com'],
    ['gh not installed', () => undefined, 'gh is not installed'],
  ])('refuses with %s, exit 2, before the model is configured, naming --local', async (_, arrange, said) => {
    const clone = await githubClone()
    arrange(clone)
    const project = await application(CONFIGURED)
    const missing: GhProcess = async () => ({ code: 'ENOENT', stdout: Buffer.alloc(0), stderr: '', timedOut: false })
    const before = await observable(clone.repo)

    // No client, no key: the configuration would be refused next, and is not reached.
    const { code, out, err } = await run(clone, submitting(clone, project), {
      ...(said === 'gh is not installed' ? { gh: missing } : {}),
    })

    expect(code).toBe(2)
    expect(err).toContain(said)
    expect(err).toContain('add --local to cut the branch in this clone only')
    expect(err).not.toContain('no model configured')
    expect(out).toBe('')
    expect(await observable(clone.repo)).toBe(before)
  })

  it('refuses a key of the clone’s own configuration that would redirect the push, exit 2, naming it and never its value', async () => {
    const clone = await githubClone()
    await git(clone.repo, 'config', 'credential.helper', 'store --file=/tmp/canary-credential-store')
    const project = await application(CONFIGURED)

    const { code, err } = await run(clone, submitting(clone, project))

    expect(code).toBe(2)
    expect(err).toContain("this clone's own configuration sets credential.helper (local), which would decide who pushes for you")
    expect(err).not.toContain('canary-credential-store')
    expect(err).not.toContain('no model configured')
  })

  it('cuts only the local branch with --local, starts no gh, and says so', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    const { code, out } = await run(clone, submitting(clone, project, ['--local']), { gh, client, ask: answering('read') })

    expect(code).toBe(0)
    expect(out).toContain('--local: nothing pushed by this run')
    expect(await ours(clone.repo)).toHaveLength(1)
    expect(await ours(clone.bare)).toEqual([])
    expect(log.filter((line) => line.startsWith('gh '))).toEqual([])
  })

  it('names the open pull request on a second run, not asked, and writes nothing', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    await run(clone, submitting(clone, project), { client: converging([CREATE_DATABASE, CREATE_ACCESS]), ask: answering('read') })
    const before = await observable(clone.repo)
    let asked = 0

    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))
    const { code, out } = await run(clone, submitting(clone, project), {
      gh,
      client,
      ask: answering('read'),
      confirm: async () => {
        asked += 1
        return true
      },
    })

    expect(code).toBe(0)
    expect(out).toMatch(/already submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} · pull request #1 is open · nothing written/)
    expect(asked).toBe(0)
    expect(log.some((line) => line.includes('POST'))).toBe(false)
    expect(await observable(clone.repo)).toBe(before)
  })

  it('asks the question of § 3 on a GitHub road, naming the push and the pull request', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const summaries: SubmissionSummary[] = []

    await run(clone, submitting(clone, project), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
      confirm: async (summary) => {
        summaries.push(summary)
        return false
      },
    })

    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.github).toStrictEqual({ host: 'github.com', repository: 'acme/iac', base: 'main', pushedAlready: false })
    expect(await ours(clone.bare)).toEqual([])
  })

  it('reports the pull request in --json, under the key --from pins (D11)', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)

    const { code, out } = await run(clone, submitting(clone, project, ['--json']), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(0)
    const { submission } = JSON.parse(out) as { submission: Record<string, unknown> }
    expect(submission).toMatchObject({
      outcome: 'created',
      pushed: true,
      pullRequest: {
        host: 'github.com',
        repository: 'acme/iac',
        number: 1,
        url: 'https://github.com/acme/iac/pull/1',
        state: 'opened',
        base: 'main',
      },
    })
  })

  it('sends every agent the bytes it sends without --submit: nothing of GitHub reaches a prompt', async () => {
    const clone = await githubClone({ login: LOGIN })
    const project = await application(CONFIGURED)
    const previewing = converging([CREATE_DATABASE, CREATE_ACCESS])
    await run(clone, ['plan', INTENT, '--repo', clone.repo, '--project', project], { client: previewing, ask: answering('read') })
    const submittingClient = converging([CREATE_DATABASE, CREATE_ACCESS])
    const { err } = await run(clone, submitting(clone, project), { client: submittingClient, ask: answering('read') })
    const login = /as ([A-Za-z0-9-]+) \(gh/.exec(err)?.[1] ?? ''

    expect(login).toBe(LOGIN)
    expect(JSON.stringify(submittingClient.seen)).toBe(JSON.stringify(previewing.seen))
    expect(JSON.stringify(submittingClient.seen)).not.toContain('github.com')
    expect(JSON.stringify(submittingClient.seen)).not.toContain(login)
  })

  it('reads nothing more of GitHub and pushes nothing when the run ends on a question', async () => {
    const clone = await githubClone()
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    // Nobody to ask: the level is a question, and the run ends on it (exit 3).
    const { code } = await run(clone, submitting(clone, project), { gh, client })

    expect(code).toBe(3)
    const first = log.findIndex((line) => line.startsWith('model '))
    expect(log.slice(first).filter((line) => line.startsWith('gh '))).toEqual([])
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('puts the forge on the trace’s root, never a login, and counts the gh calls it made', async () => {
    const clone = await githubClone({ login: LOGIN })
    const project = await application(CONFIGURED)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))
    const sink = memorySink()

    const { code, err } = await run(clone, submitting(clone, project), { gh, client, ask: answering('read'), traceSinks: [sink] })

    expect(code).toBe(0)
    const trace = onlyTrace(sink)
    const root = trace.spans[0]?.attributes ?? {}
    const calls = log.filter((line) => line.startsWith('gh ')).length
    expect(root).toMatchObject({
      'idp.forge.kind': 'github',
      'idp.forge.host': 'github.com',
      'idp.forge.base': 'main',
      'idp.forge.pull_request': 1,
      'idp.forge.outcome': 'created',
      'idp.forge.pushed': true,
      'idp.forge.gh_calls': calls,
    })
    expect(calls).toBeLessThanOrEqual(GITHUB_LIMITS.ghCalls)
    const login = /as ([A-Za-z0-9-]+) \(gh/.exec(err)?.[1] ?? ''
    expect(login).toBe(LOGIN)
    expect(JSON.stringify(trace, (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(login)
  })
})

describe('plan "<intent>" --submit and iacRepo', { timeout: PUSHING }, () => {
  afterAll(removeClones)

  it('puts where a refusal before any model would have gone on the trace’s root: the forge, refused, the gh calls made', async () => {
    // § 12: every result of a submission carries the forge, a refusal before
    // the preview included — the cross-check, the divergence, the rules.
    for (const arrange of [
      async () => ({ clone: await githubClone(), config: 'iacRepo: github.com/acme/other-iac\nenvironments: [prod]\n' }),
      async () => {
        const clone = await githubClone()
        unprotect(clone.gh)
        return { clone, config: CONFIGURED }
      },
      async () => {
        const clone = await githubClone()
        await writeFile(path.join(clone.repo, 'catalog', 'databases', 'stray.yml'), '# stray\n', 'utf8')
        return { clone, config: CONFIGURED }
      },
    ]) {
      const { clone, config } = await arrange()
      const project = await application(config)
      const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))
      const sink = memorySink()

      const { code } = await run(clone, submitting(clone, project), { gh, client, ask: answering('read'), traceSinks: [sink] })

      expect(code).toBe(1)
      expect(log.filter((line) => line.startsWith('model '))).toEqual([])
      expect(onlyTrace(sink).spans[0]?.attributes).toMatchObject({
        'idp.forge.kind': 'github',
        'idp.forge.repository': 'acme/iac',
        'idp.forge.outcome': 'refused',
        'idp.forge.gh_calls': log.filter((line) => line.startsWith('gh ')).length,
      })
    }
  })

  it('refuses a service whose iacRepo names another repository, exit 1, naming both, before any model and any read of GitHub', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: github.com/acme/other-iac\nenvironments: [dev, staging, prod]\n')
    // An uncommitted file under catalog/ nobody can read: the read of the
    // contents would refuse it (exit 2), and the divergence after it, so the
    // iacRepo line printed alone says the cross-check ran before either. The
    // snapshot records such a file rather than refusing it, so a cross-check
    // after it is not something an output can tell.
    const stray = path.join(clone.repo, 'catalog', 'databases', 'stray.yml')
    await writeFile(stray, '# stray\n', 'utf8')
    await chmod(stray, 0o000)
    const { log, gh, client } = watching(clone, converging([CREATE_DATABASE, CREATE_ACCESS]))

    const { code, out } = await run(clone, submitting(clone, project), { gh, client, ask: answering('read') })

    expect(code).toBe(1)
    // The two paths are printed as `main` resolved them; the sentence around them is pinned.
    expect(out.startsWith('not submitted — .idp-agent.yml in ')).toBe(true)
    expect(out).toContain("names github.com/acme/other-iac as this service's declarations repository, and ")
    expect(out.trimEnd()).toMatch(
      /'s main tracks github\.com\/acme\/iac: run this with --repo naming a clone of the repository it names, or change iacRepo in a reviewed change\. Nothing was written\.$/,
    )
    expect(out.trimEnd().split('\n')).toHaveLength(1)
    expect(log.filter((line) => line.startsWith('model '))).toEqual([])
    // gh's version and identity, read in main before the configuration; no route of the repository.
    expect(log.filter((line) => /repos\//.test(line))).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a locator that names no repository on github.com, quoting it', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: gitlab.example.com/acme/iac\nenvironments: [prod]\n')

    const { code, out } = await run(clone, submitting(clone, project), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(out).toContain('names gitlab.example.com/acme/iac as this service')
  })

  it.each([
    'https://github.com/acme/iac.git',
    'github.com/ACME/IaC',
    'ssh://github.com/acme/iac/',
  ])('submits when iacRepo names the same repository, written as %s', async (locator) => {
    const clone = await githubClone()
    const project = await application(`iacRepo: ${locator}\nenvironments: [dev, staging, prod]\n`)

    const { code, out } = await run(clone, submitting(clone, project), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(out).toContain('Pull request #1 opened on github.com/acme/iac')
  })

  it('reads no iacRepo where nothing leaves the clone: --local, no --submit, a clone that tracks nothing', async () => {
    const project = await application('iacRepo: github.com/acme/other-iac\nenvironments: [dev, staging, prod]\n')
    const tracked = await githubClone()
    const untracked = await clone()

    for (const [repo, extra] of [
      [tracked.repo, ['--submit', '--local']],
      [tracked.repo, []],
      [untracked, ['--submit']],
    ] as const) {
      const { code } = await run(tracked, ['plan', INTENT, '--repo', repo, '--project', project, ...extra], {
        client: converging([CREATE_DATABASE, CREATE_ACCESS]),
        ask: answering('read'),
      })
      expect(code).toBe(0)
    }
  })

  it('spells out a control or bidi character of iacRepo in --json\'s reasons, as in prose', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: "github.com/acme/\u202Eiac"\nenvironments: [prod]\n')

    for (const extra of [[], ['--json']]) {
      const { code, out } = await run(clone, submitting(clone, project, extra), {
        client: converging([CREATE_DATABASE, CREATE_ACCESS]),
        ask: answering('read'),
      })

      expect(code).toBe(1)
      expect(out).toContain('github.com/acme/')
      expect(out).not.toContain('\u202E')
    }
  })

  it('answers the mismatch in --json with the submission key alone', async () => {
    const clone = await githubClone()
    const project = await application('iacRepo: github.com/acme/other-iac\nenvironments: [prod]\n')

    const { code, out } = await run(clone, submitting(clone, project, ['--json']), {
      client: converging([CREATE_DATABASE, CREATE_ACCESS]),
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(Object.keys(JSON.parse(out) as object)).toEqual(['submission'])
    expect(JSON.parse(out)).toMatchObject({ submission: { outcome: 'refused' } })
  })
})
