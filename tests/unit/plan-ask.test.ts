import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import {
  ASK_LIMITS,
  fillAnswers,
  runIntent,
  runPlan,
  type Ask,
} from '../../src/cli/commands/plan.js'
import type { Question } from '../../src/core/plan/clarify.js'
import type { Plan } from '../../src/core/schemas/plan.js'
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

/**
 * §7.5, the half that was missing: the CLI does not print a question and leave.
 * It ASKS, and carries on with the answer.
 *
 * Every test here injects `ask`, which is what makes the whole interactive path
 * testable with no terminal — the same seam `out`, `err` and `client` already
 * are. Nothing below reads stdin, and the one test that asserts the
 * non-interactive behaviour asserts it through `main` with the sinks injected,
 * because an injected sink is exactly what tells `main` there is nobody there.
 *
 * And every one of them hashes both repositories. "Preview only — writes
 * nothing" is a claim about EVERY outcome, and an answered run is four new
 * outcomes: answered, declined, refused, and out of rounds.
 */

/** Replays a scripted sequence of model turns, keyed by AGENT (see plan-intent). */
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
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
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

/**
 * An `ask` that answers from a list and keeps what it was shown.
 *
 * The questions are kept because the prompt is half the contract: a person is
 * shown the dotted path AND the model's own reason, and a test that only
 * checked the answers would let either of those disappear.
 */
/**
 * Answers by PATH rather than by turn.
 *
 * A grant now always carries one question of its own — the level, which is
 * asked and never read out of the request — so a fixture about something else
 * would otherwise have to know where that question lands in the order. It
 * answers `read` for the level and the given value for the field under test.
 */
const answeringPath = (
  byPath: Record<string, string | undefined>,
): { ask: Ask; asked: Question[] } => {
  const asked: Question[] = []
  const ask: Ask = async (question) => {
    asked.push(question)
    if (question.path.endsWith('.access')) return 'read'
    for (const [suffix, value] of Object.entries(byPath)) {
      if (question.path.endsWith(suffix)) return value
    }
    return undefined
  }
  return { ask, asked }
}

const answering = (
  values: readonly (string | undefined)[],
): { ask: Ask; asked: Question[] } => {
  const asked: Question[] = []
  let spent = 0
  const ask: Ask = async (question) => {
    asked.push(question)
    const value = values[spent]
    spent += 1
    return value
  }
  return { ask, asked }
}

/** An `ask` that says the same thing however often it is asked. */
const alwaysSaying = (value: string): { ask: Ask; asked: Question[] } => {
  const asked: Question[] = []
  const ask: Ask = async (question) => {
    asked.push(question)
    return value
  }
  return { ask, asked }
}

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-ask-'))

/** The declarations repository, exactly as `init platform` leaves one. */
const scaffoldedRepository = async (): Promise<string> => {
  const repo = path.join(await temp(), 'iac')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return repo
}

/** The APPLICATION repository the Inspector reads (§7.4, step 3). */
const application = async (): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8' } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '* @acme/platform\n', 'utf8')
  return root
}

/** Written beside the repository, never inside it: a plan is not a declaration. */
const planFile = async (repo: string, plan: unknown): Promise<string> => {
  const file = path.join(path.dirname(repo), 'plan.json')
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return file
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

/**
 * The owner is the one value the request does not carry, so the signer turns it
 * into the single question of §7.5 — the same plan the "asks rather than
 * guesses" test in plan-intent.test.ts stops on.
 */
const ONE_QUESTION = 'declare the database orders-db-prod in prod'

const CREATE_DATABASE = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

/**
 * Two questions, and the name is deliberately NOT one of them: every segment of
 * `orders-db` is in the request, so `composed()` vouches for it. What is left
 * is the environment the request never named and the owner nobody stated — and
 * they are asked in the order `findUnknowns` walks them.
 */
const TWO_QUESTIONS = 'declare the database orders-db'

const CREATE_DATABASE_UNSCOPED = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

const OWNER_PATH = 'operations.0.entity.spec.owner'
const ENV_PATH = 'operations.0.entity.metadata.env'
const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

/** Inspector reports, Architect proposes, Reviewer accepts. One turn each. */
const converging = (operations: unknown[]): LlmClient & { seen: GenerateRequest[] } =>
  scripted({
    inspector: [turnCalling(REPORT_TOOL, FACTS)],
    architect: [turnCalling(PROPOSE_TOOL, { operations })],
    reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
  })

describe('plan "<intent>" asks, and carries on with the answer', () => {
  it('puts the one question to the user and ends on the diff', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask, asked } = answering(['group:default/tiger'])

    const result = await runIntent({
      intent: ONE_QUESTION,
      repo,
      project,
      client: converging([CREATE_DATABASE]),
      emit: collect().emit,
      ask,
    })

    expect(asked.map((question) => question.path)).toEqual([OWNER_PATH])
    // The model's own reason, never a paraphrase: the reason IS the question.
    expect(asked[0]?.question).toMatch(/owner/)
    expect(result.found).toBe(true)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain(`+++ b/${DATABASE_PATH}`)
    expect(result.text).toContain('+  owner: group:default/tiger')
    expect(result.text.trimEnd().endsWith(CLOSING)).toBe(true)
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('never asks the answered field a second time', async () => {
    // The defect this exists to prevent. The signature measures provenance
    // against the request, so a value the user typed and the request does not
    // carry classifies `novel` on the next pass — and the same question comes
    // back for ever. The answer joins the request; see `withAnswers`.
    const repo = await scaffoldedRepository()
    const project = await application()
    const { ask, asked } = answering(['group:default/tiger', 'group:default/tiger'])

    const result = await runIntent({
      intent: ONE_QUESTION,
      repo,
      project,
      client: converging([CREATE_DATABASE]),
      emit: collect().emit,
      ask,
      json: true,
    })

    expect(asked).toHaveLength(1)
    const report = JSON.parse(result.text) as {
      outcome: string
      plan: { intent: string }
      signature: { classified: { path: string; class: string }[] }
      attempts: { gates: string[] }[]
    }
    expect(report.outcome).toBe('planned')
    // Both rounds, not the last one. `repair` counts what a run spent and says
    // a seam is where that signal died once already; an answered run is several
    // calls to it, so this is that seam.
    expect(report.attempts.map((one) => one.gates)).toEqual([
      // The round that ended on the question: the three free gates, and no
      // round-trip was ever paid for it.
      ['zod', 'signature', 'policy'],
      ['zod', 'signature', 'policy', 'recheck', 'reviewer'],
    ])
    // `echoed`, and that is the claim being made: the user said it. Not
    // `enumerated` — a fresh repository enumerates no owner at all.
    expect(report.signature.classified.find((leaf) => leaf.path === OWNER_PATH)?.class).toBe(
      'echoed',
    )
    // The request is what the USER wrote, unchanged. The loop used to grow it
    // with each answer so `echoes` would find the value again — which put
    // sentences nobody typed into a `--json` report, and made a common word
    // answered once vouch for every occurrence of it afterwards. An answer is
    // its own provenance now, and it does not pass through the request.
    expect(report.plan.intent).toBe(ONE_QUESTION)
  })

  it('asks every question, one at a time, in the order the plan states them', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask, asked } = answering(['prod', 'group:default/tiger'])

    const result = await runIntent({
      intent: TWO_QUESTIONS,
      repo,
      project,
      client: converging([CREATE_DATABASE_UNSCOPED]),
      emit: collect().emit,
      ask,
    })

    expect(asked.map((question) => question.path)).toEqual([ENV_PATH, OWNER_PATH])
    expect(result.found).toBe(true)
    expect(result.text).toContain('+++ b/catalog/databases/orders-db.yml')
    expect(result.text).toContain('+    company.fr/env: prod')
    expect(result.text).toContain('+  owner: group:default/tiger')
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('stops on a decline, names what is still unanswered, and previews nothing', async () => {
    // `undefined` is the user saying they will not answer. Nothing was kept and
    // nothing was written; what is left is the question they stopped on.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask, asked } = answering(['prod', undefined])

    const result = await runIntent({
      intent: TWO_QUESTIONS,
      repo,
      project,
      client: converging([CREATE_DATABASE_UNSCOPED]),
      emit: collect().emit,
      ask,
    })

    expect(asked).toHaveLength(2)
    expect(result.unsupported).toBe(true)
    expect(result.found).toBe(false)
    expect(result.text).toContain(OWNER_PATH)
    expect(result.text).not.toContain(ENV_PATH)
    expect(result.text).not.toContain('@@')
    expect(result.text).not.toContain(CLOSING)
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('reads an empty line as a decline, never as an empty value', async () => {
    // A terminal cannot tell "I do not know either" from a stray Return, and an
    // empty string is a value every gate below would wave through — `echoes`
    // vouches for it — so it would reach the diff as a field with nothing in it.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask } = answering([''])

    const result = await runIntent({
      intent: ONE_QUESTION,
      repo,
      project,
      client: converging([CREATE_DATABASE]),
      emit: collect().emit,
      ask,
    })

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain(OWNER_PATH)
    expect(result.text).not.toContain('@@')
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('gives up after a bounded number of rounds, cleanly', async () => {
    // A run that keeps producing questions has to end. The user answers with
    // something the schema will not take, gate [1] hands it back, the Architect
    // proposes the same unvouched owner again, and the question returns. After
    // `maxRounds` the run stops the way a non-interactive one does: the
    // questions, exit 3, no diff.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask, asked } = alwaysSaying('tiger')
    const proposed = turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE] })

    const result = await runIntent({
      intent: ONE_QUESTION,
      repo,
      project,
      client: scripted({
        inspector: [turnCalling(REPORT_TOOL, FACTS)],
        architect: [proposed, proposed, proposed, proposed],
        reviewer: [],
      }),
      emit: collect().emit,
      ask,
    })

    expect(asked).toHaveLength(ASK_LIMITS.maxRounds)
    expect(result.unsupported).toBe(true)
    expect(result.found).toBe(false)
    expect(result.text).toContain(OWNER_PATH)
    expect(result.text).not.toContain('@@')
    expect(await hashBoth(repo, project)).toBe(before)
  })
})

describe('plan --from asks too, because both roads have the same outcome', () => {
  it('answers the question and renders the diff the intent form renders', async () => {
    const repo = await scaffoldedRepository()
    const from = await planFile(repo, {
      intent: ONE_QUESTION,
      operations: [CREATE_DATABASE],
    })
    const before = await hashTree(repo)
    const { ask, asked } = answering(['group:default/tiger'])

    const result = await runPlan({ from, repo, ask })

    expect(asked.map((question) => question.path)).toEqual([OWNER_PATH])
    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${DATABASE_PATH}`)
    expect(result.text).toContain('+  owner: group:default/tiger')
    expect(await hashTree(repo)).toBe(before)
  })

  it('refuses an answer the schema will not take, naming the field', async () => {
    // Gate [1] again, over the plan the user just changed. `--from` has no
    // Architect to hand a refusal back to, so it is a clean stop rather than a
    // repair — and never a crash, and never an invalid owner in a diff.
    const repo = await scaffoldedRepository()
    const from = await planFile(repo, {
      intent: ONE_QUESTION,
      operations: [CREATE_DATABASE],
    })
    const before = await hashTree(repo)
    const { ask } = answering(['tiger'])

    const result = await runPlan({ from, repo, ask })

    expect(result.found).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('owner')
    expect(result.text).not.toContain('@@')
    expect(await hashTree(repo)).toBe(before)
  })

  it('prints the questions and previews nothing when there is nobody to ask', async () => {
    const repo = await scaffoldedRepository()
    const from = await planFile(repo, {
      intent: ONE_QUESTION,
      operations: [CREATE_DATABASE],
    })
    const before = await hashTree(repo)

    const result = await runPlan({ from, repo })

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain(OWNER_PATH)
    expect(result.text).not.toContain('@@')
    expect(await hashTree(repo)).toBe(before)
  })
})

describe('an answer aimed at a field that is not a question', () => {
  it('is refused rather than crashing, in `answer`’s own words', async () => {
    // `clarify.answer` already refuses this, and the reason it does is that an
    // answer aimed at a settled field is how a value the engine vouched for
    // gets overwritten by one nobody did. The CLI's job is to surface that
    // refusal; the list and the plan it fills can only disagree through a
    // miswiring above, and a miswiring must not reach the user as a stack.
    const settled: Plan = {
      intent: ONE_QUESTION,
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'orders-db-prod', env: 'prod' },
            spec: { type: 'database', owner: 'group:default/tiger' },
          },
        },
      ],
    }
    const { ask, asked } = answering(['group:default/badger'])

    const filling = await fillAnswers(
      settled,
      [{ path: OWNER_PATH, question: 'who owns it?' }],
      ask,
    )

    expect(asked).toHaveLength(1)
    expect(filling.outcome).toBe('refused')
    expect(filling.outcome === 'refused' && filling.reason).toContain('not a question')
    expect(filling.outcome === 'refused' && filling.reason).toContain(OWNER_PATH)
  })
})

describe('plan through main', () => {
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

  it('prints the questions and exits 3 when stdin is nobody — exactly as before', async () => {
    // A script has nobody to ask, and blocking on a read is the worst thing a
    // CLI in a pipeline can do. An injected sink IS that case: main reads no
    // stdin under one, so this is byte-for-byte the behaviour of the build
    // before `ask` existed.
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)

    const { code, out } = await run(['plan', ONE_QUESTION, '--repo', repo], {
      cwd: project,
      client: converging([CREATE_DATABASE]),
      env: {},
    })

    expect(code).toBe(3)
    expect(out).toContain('1 question, asked rather than guessed:')
    expect(out).toContain(OWNER_PATH)
    expect(out).toContain('Fill them in and run this again.')
    expect(out).not.toContain('@@')
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('exits 0 with the diff once an injected ask answers it', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask } = answering(['group:default/tiger'])

    const { code, out, err } = await run(['plan', ONE_QUESTION, '--repo', repo], {
      cwd: project,
      client: converging([CREATE_DATABASE]),
      env: {},
      ask,
    })

    expect(code).toBe(0)
    expect(out).toContain(`+++ b/${DATABASE_PATH}`)
    // The prompt belongs on stderr; stdout carries the diff a pipe reads. An
    // injected `ask` writes nowhere at all, which is the point of injecting it.
    expect(err).not.toContain(OWNER_PATH)
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('exits 3 on a decline, with nothing on stdout but the question', async () => {
    const repo = await scaffoldedRepository()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask } = answering([undefined])

    const { code, out } = await run(['plan', ONE_QUESTION, '--repo', repo], {
      cwd: project,
      client: converging([CREATE_DATABASE]),
      env: {},
      ask,
    })

    expect(code).toBe(3)
    expect(out).toContain(OWNER_PATH)
    expect(out).not.toContain('@@')
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('answers a --from run the same way, with the same code', async () => {
    const repo = await scaffoldedRepository()
    const from = await planFile(repo, { intent: ONE_QUESTION, operations: [CREATE_DATABASE] })
    const before = await hashTree(repo)
    const { ask } = answering(['group:default/tiger'])

    const { code, out } = await run(['plan', '--from', from, '--repo', repo], { ask })

    expect(code).toBe(0)
    expect(out).toContain(`+++ b/${DATABASE_PATH}`)
    expect(await hashTree(repo)).toBe(before)
  })
})

/**
 * F2, end to end: a derived value must die with the evidence it was read from.
 *
 * The audit's sequence needs a catalogue rather than a fresh repository — two
 * components owned by two different teams, so that answering the consumer
 * question changes WHICH team the owner follows from. Everything below declares
 * that catalogue on disk, because `contextsOf` builds the owners map and the
 * vocabulary off the same graph it reads from these bytes, and a hand-written
 * map would be testing a repository no reader could produce.
 */

const componentDocument = (name: string, owner: string): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    `  name: ${name}`,
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: service',
    '  lifecycle: production',
    `  owner: ${owner}`,
    '',
  ].join('\n')

const DATABASE_DOCUMENT = [
  '---',
  'apiVersion: backstage.io/v1alpha1',
  'kind: Resource',
  'metadata:',
  '  name: orders-db-prod',
  '  annotations:',
  '    company.fr/env: prod',
  'spec:',
  '  type: database',
  '  owner: group:default/tiger',
  '',
].join('\n')

/**
 * The declarations repository, plus the entities these tests read owners off.
 *
 * `init platform` scaffolds no Component folder — a service is declared in its
 * own repository — so the witness goes in beside them, exactly as the scenario
 * fixtures do: a folder exists in this repository when a witness says so.
 */
const catalogued = async (): Promise<string> => {
  const repo = await scaffoldedRepository()
  const files: Record<string, string> = {
    'catalog/components/.witness.yml': '---\n',
    'catalog/components/billing-api.yml': componentDocument('billing-api', 'group:default/tiger'),
    'catalog/components/payments-api.yml': componentDocument('payments-api', 'group:default/lion'),
    'catalog/databases/orders-db-prod.yml': DATABASE_DOCUMENT,
  }
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(repo, ...relative.split('/'))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, text, 'utf8')
  }
  return repo
}

/** The opening message of a request. Narrowed: a tool entry carries no text. */
const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

/**
 * The one value the request does not carry is the CONSUMER, and that is the
 * whole point: the owner follows from it, so answering it moves the owner.
 * Every other leaf is echoed verbatim.
 */
const CONSUMER_QUESTION =
  'open a database-access granting read to resource:default/orders-db-prod in prod, ' +
  'named billing-api-orders-db-prod'

const CONSUMER_PATH = 'operations.0.entity.spec.dependencyOf.0'

const accessFor = (consumer: string, owner: unknown) => ({
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access', access: 'read',
      owner,
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: [consumer],
    },
  },
})

/** The draft the audit describes: a consumer nobody asked for, and no owner. */
const PROPOSES_PAYMENTS = accessFor('component:default/payments-api', {
  unknown: 'the request does not state an owner for this access',
})

const derivedEvents = (
  events: readonly AgentEvent[],
): { owner: string; from: readonly string[] }[] =>
  events
    .filter((event): event is Extract<AgentEvent, { type: 'derived' }> => event.type === 'derived')
    .map((event) => ({ owner: event.owner, from: event.from }))

describe('a derived owner does not outlive the consumer it was read off', () => {
  it('re-derives the owner from the consumer the user actually answered', async () => {
    // The audit's sequence. Round 1 reads `payments-api` and writes lion's
    // reference into the plan; the user rejects that consumer and says
    // `billing-api`, which tiger owns. The run may not end on a diff carrying
    // lion's authorisation and billing-api's consumer — `payments-api` is in
    // neither the request nor the plan by then, so nothing vouches for lion.
    const repo = await catalogued()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask, asked } = answeringPath({ '.dependencyOf.0': 'component:default/billing-api' })

    const result = await runIntent({
      intent: CONSUMER_QUESTION,
      repo,
      project,
      client: converging([PROPOSES_PAYMENTS]),
      emit: collect().emit,
      ask,
    })

    // Two questions, not one: a grant carries its level as a question of its
    // own now, and that is the friction the rule costs — one prompt per grant
    // whose level the request did not settle.
    expect(asked.map((question) => question.path)).toContain(CONSUMER_PATH)
    expect(result.found).toBe(true)
    expect(result.text).toContain('+  owner: group:default/tiger')
    expect(result.text).toContain('+    - component:default/billing-api')
    expect(result.text).not.toContain('group:default/lion')
    expect(result.text).not.toContain('payments-api')
    expect(await hashBoth(repo, project)).toBe(before)
  })

  it('says both derivations out loud, and the second one supersedes the first', async () => {
    // Stated, never silent — in every round, not only the one that happened to
    // run first. The terminal saw lion; it has to see that lion was replaced.
    const repo = await catalogued()
    const project = await application()
    const { events, emit } = collect()
    const { ask } = answeringPath({ '.dependencyOf.0': 'component:default/billing-api' })

    await runIntent({
      intent: CONSUMER_QUESTION,
      repo,
      project,
      client: converging([PROPOSES_PAYMENTS]),
      emit,
      ask,
    })

    expect(derivedEvents(events)).toEqual([
      { owner: 'group:default/lion', from: ['component:default/payments-api'] },
      { owner: 'group:default/tiger', from: ['component:default/billing-api'] },
    ])
  })

  it('tells the Reviewer about the derivation that is standing when it runs', async () => {
    // The half of F2 that made it invisible: the Reviewer runs once, in the
    // last round, and it was handed an empty `derived` list while lion's
    // reference sat in the JSON it was reading. It now sees the derivation the
    // pass it is reviewing actually performed.
    const repo = await catalogued()
    const project = await application()
    const client = converging([PROPOSES_PAYMENTS])
    const { ask } = answeringPath({ '.dependencyOf.0': 'component:default/billing-api' })

    await runIntent({
      intent: CONSUMER_QUESTION,
      repo,
      project,
      client,
      emit: collect().emit,
      ask,
    })

    const opening = openingOf(client.seen.find((request) => request.agent === 'reviewer'))
    expect(opening).toContain('values the engine computed')
    expect(opening).toContain('component:default/billing-api')
    expect(opening).not.toContain('group:default/lion')
  })

  it('derives the same owner again when the consumer is answered with itself', async () => {
    // The case that must not regress into a question: nothing moved, so the
    // owner the first round derived is the owner the second round derives.
    const repo = await catalogued()
    const project = await application()
    const { events, emit } = collect()
    const { ask, asked } = answeringPath({ '.dependencyOf.0': 'component:default/billing-api' })
    const proposal = accessFor('component:default/billing-api', {
      unknown: 'the request does not state an owner for this access',
    })

    const result = await runIntent({
      intent: CONSUMER_QUESTION,
      repo,
      project,
      client: converging([proposal]),
      emit,
      ask,
    })

    // Two questions, not one: a grant carries its level as a question of its
    // own now, and that is the friction the rule costs — one prompt per grant
    // whose level the request did not settle.
    expect(asked.map((question) => question.path)).toContain(CONSUMER_PATH)
    expect(result.found).toBe(true)
    expect(result.text).toContain('+  owner: group:default/tiger')
    expect(derivedEvents(events)).toEqual([
      { owner: 'group:default/tiger', from: ['component:default/billing-api'] },
      { owner: 'group:default/tiger', from: ['component:default/billing-api'] },
    ])
  })

  it('keeps an owner the user stated, through an answer that changes the consumer', async () => {
    // The rule the fix must not break. `group:default/lynx` is in the request
    // and nowhere else — not in this catalogue, not in any consumer — and the
    // request is the strongest claim a value can carry. Answering the consumer
    // does not move it.
    const repo = await catalogued()
    const project = await application()
    const { events, emit } = collect()
    const { ask } = answeringPath({ '.dependencyOf.0': 'component:default/billing-api' })
    const proposal = accessFor('component:default/payments-api', 'group:default/lynx')

    const result = await runIntent({
      intent: `${CONSUMER_QUESTION}, owned by group:default/lynx`,
      repo,
      project,
      client: converging([proposal]),
      emit,
      ask,
    })

    expect(result.found).toBe(true)
    expect(result.text).toContain('+  owner: group:default/lynx')
    // Nothing was derived, in either round: the request answered the question
    // before the catalogue was asked.
    expect(derivedEvents(events)).toEqual([])
  })

  it('withdraws a derived owner when the answer leaves nothing to derive from', async () => {
    // The other half of "dies with its evidence". The user answers the
    // consumer with a component this catalogue declares nothing about, so
    // there is no owner to read — and the owner an earlier round wrote is not
    // a value that may stand in its place. It goes back to being a question.
    const repo = await catalogued()
    const project = await application()
    const before = await hashBoth(repo, project)
    const { ask, asked } = answeringPath({
      '.dependencyOf.0': 'component:default/nobody-declares-this',
    })

    const result = await runIntent({
      intent: CONSUMER_QUESTION,
      repo,
      project,
      client: converging([PROPOSES_PAYMENTS]),
      emit: collect().emit,
      ask,
    })

    // The owner is asked because the consumer it was derived from is gone —
    // that is the guarantee. The level is asked because every grant's is.
    const paths = asked.map((question) => question.path)
    expect(paths).toContain(CONSUMER_PATH)
    expect(paths).toContain(OWNER_PATH)
    expect(result.found).toBe(false)
    expect(result.text).not.toContain('group:default/lion')
    expect(await hashBoth(repo, project)).toBe(before)
  })
})
