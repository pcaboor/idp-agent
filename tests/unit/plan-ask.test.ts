import { mkdtemp, writeFile } from 'node:fs/promises'
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
      ['zod', 'signature', 'policy', 'reviewer', 'recheck'],
    ])
    // `echoed`, and that is the claim being made: the user said it. Not
    // `enumerated` — a fresh repository enumerates no owner at all.
    expect(report.signature.classified.find((leaf) => leaf.path === OWNER_PATH)?.class).toBe(
      'echoed',
    )
    // The request the gate measured against, and it says where the value came
    // from rather than pretending the original sentence carried it.
    expect(report.plan.intent).toContain(ONE_QUESTION)
    expect(report.plan.intent).toContain('group:default/tiger')
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
