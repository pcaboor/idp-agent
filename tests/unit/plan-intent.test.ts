import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, renderEvent } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runIntent } from '../../src/cli/commands/plan.js'
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
 * complete plan has to answer for it — which is what a person does. Every
 * other question is left unanswered, so a test about an unvouched owner still
 * tests that.
 */
const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : undefined
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
    // An API the repository declares is read and not modelled: it exists.
    // Counted as dangling, the summary the Architect reads called the
    // repository broken where `validate` does not.
    const repo = await scaffoldedRepository()
    await mkdir(path.join(repo, 'catalog', 'apis'), { recursive: true })
    await writeFile(
      path.join(repo, 'catalog', 'apis', 'billing-events.yml'),
      '---\napiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing-events\n',
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

describe('what a run looks like on a terminal', () => {
  it('renders one line per event, and nothing for the two that are the answer', () => {
    // Stage 7 draws these with Ink. Until then the stream has to be legible as
    // a log: appended lines, no cursor movement, nothing that needs a TTY.
    expect(renderEvent({ type: 'agent:start', agent: 'architect' })).toBe('· architect')
    expect(renderEvent({ type: 'tool:call', name: 'search_entities', args: { env: 'prod' } })).toBe(
      '  → search_entities',
    )
    expect(renderEvent({ type: 'tool:result', name: 'search_entities', rows: 25, truncated: 3 })).toBe(
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
    // The questions and the answer ARE what the command prints, on stdout. A
    // stderr copy would state one fact twice.
    expect(renderEvent({ type: 'answer:ready', refs: ['resource:default/x'] })).toBeUndefined()
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
})
