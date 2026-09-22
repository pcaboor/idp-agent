import { describe, expect, it } from 'vitest'
import { draftPlan, type ArchitectOutcome } from '../../src/agents/architect.js'
import type { AgentEvent } from '../../src/agents/events.js'
import {
  REPAIR_LIMITS,
  repair,
  type Gate,
  type RepairInput,
  type RepairOutcome,
} from '../../src/agents/repair.js'
import { reviewPlan, VERDICT_TOOL, type Verdict } from '../../src/agents/reviewer.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import type { ProjectFacts } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { computeEntityPath } from '../../src/core/paths/entity-path.js'
import type { PolicyContext } from '../../src/core/plan/policies.js'
import type { SignatureContext } from '../../src/core/plan/sign.js'
import { SOURCE_FILE_ANNOTATION, type Entity } from '../../src/core/schemas/entity.js'
import { planSchema, type Plan } from '../../src/core/schemas/plan.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
import type { RepositoryFile, RepositorySnapshot } from '../../src/core/validate/rules.js'
import { serializeEntity } from '../../src/core/yaml/serialize.js'
import type { GenerateResult, LlmClient, ModelToolCall } from '../../src/llm/client.js'

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

const toolCall = (name: string, args: unknown): ModelToolCall => ({ id: 'c1', name, args })
const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [toolCall(name, args)],
  finishReason: 'tool-calls',
})

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

const eventsOfType = <T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

/**
 * Narrowing helpers that fail with the outcome the loop actually produced.
 * `expect(outcome.outcome).toBe('planned')` says the shape was wrong; these say
 * which shape came back instead, which is the half that saves a debugging pass.
 */
const planned = (outcome: RepairOutcome): Extract<RepairOutcome, { outcome: 'planned' }> => {
  if (outcome.outcome !== 'planned') throw new Error(`expected a plan, got ${outcome.outcome}`)
  return outcome
}
const stopped = (outcome: RepairOutcome): Extract<RepairOutcome, { outcome: 'stopped' }> => {
  if (outcome.outcome !== 'stopped') throw new Error(`expected a stop, got ${outcome.outcome}`)
  return outcome
}
const asking = (outcome: RepairOutcome): Extract<RepairOutcome, { outcome: 'questions' }> => {
  if (outcome.outcome !== 'questions') throw new Error(`expected questions, got ${outcome.outcome}`)
  return outcome
}

const INTENT = 'give billing-api access to orders-db in prod'
/** The same request, aimed at dev. What the plan below is measured against. */
const DEV_INTENT = 'give billing-api access to orders-db in dev'

const VOCABULARY = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

/** References the ENGINE returned — what a run's read tools would have filled. */
const WITNESSED = new Set(['resource:default/orders-db-prod', 'component:default/billing-api'])

const signature = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  witnessed: WITNESSED,
  vocabulary: VOCABULARY,
  repoRoot: '/repo',
  declared: new Map(),
  ...over,
})

const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  vocabulary: VOCABULARY,
  witnesses: new Set(['catalog/databases', 'catalog/components', 'dependencies/access']),
  environments: new Map([
    ['resource:default/orders-db-prod', 'prod'],
    ['component:default/billing-api', 'prod'],
  ]),
  ...over,
})

const ORDERS_DB: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'orders-db-prod', annotations: { [ENV_ANNOTATION]: 'prod' } },
  spec: { type: 'database', owner: 'group:default/tiger' },
}

const BILLING_API: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'billing-api',
    annotations: {
      [ENV_ANNOTATION]: 'prod',
      [SOURCE_FILE_ANNOTATION]: 'catalog/components/billing-api.yml',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
}

const fileHolding = (path: string, entity: Entity): RepositoryFile => ({
  path,
  entities: [entity],
  rejections: [],
  documents: 1,
})

const SNAPSHOT: RepositorySnapshot = {
  folders: ['catalog/databases', 'catalog/components', 'dependencies/access'],
  witnesses: ['catalog/databases', 'catalog/components', 'dependencies/access'],
  files: [
    fileHolding('catalog/databases/orders-db-prod.yml', ORDERS_DB),
    fileHolding('catalog/components/billing-api.yml', BILLING_API),
  ],
}

/**
 * The bytes the repository holds, composed from the same entities the snapshot
 * parsed. The loop is handed both because it may not read either (`agents/`
 * touches no disk), and a test that hand-wrote the text would be asserting
 * against a repository the reader could never produce.
 */
const bytesOf = (snapshot: RepositorySnapshot): ReadonlyMap<string, string> =>
  new Map(
    snapshot.files.map((file) => [
      file.path,
      file.entities.map((entity) => `---\n${serializeEntity(entity)}`).join('\n'),
    ]),
  )

/** The access declaration a sound draft proposes. */
const ACCESS = {
  kind: 'Resource',
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: {
    type: 'database-access',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
    dependencyOf: ['component:default/billing-api'],
  },
}

/**
 * Parsed, never written out as a literal: `repair` is handed plans that came
 * through the boundary, and a fixture the schema would refuse would test the
 * loop against a plan that cannot exist. The one exception below says so.
 */
const planOf = (entity: unknown, intent = INTENT): Plan =>
  planSchema.parse({ intent, operations: [{ op: 'create-entity', entity }] })

const PLAN = planOf(ACCESS)

/** Zod-valid, and prod is an environment this request never named (§6.1 gate [3]). */
const MISMATCHED = planOf(
  { ...ACCESS, metadata: { name: 'billing-api-orders-db-prod', env: 'dev' } },
  DEV_INTENT,
)

/** The same access, correct for a dev request: no prod resource consumed. */
const DEV_PLAN = planOf(
  {
    ...ACCESS,
    metadata: { name: 'billing-api-orders-db-dev', env: 'dev' },
    spec: { type: 'database-access' as const, owner: 'group:default/tiger' },
  },
  DEV_INTENT,
)

/** An owner no tool returned and no vocabulary holds: a question, not a defect. */
const UNVOUCHED = planOf({ ...ACCESS, spec: { ...ACCESS.spec, owner: 'group:default/ghost' } })

/** The model's own `{unknown}`, which arrives already asked. */
const ASKED = planOf({
  ...ACCESS,
  metadata: { name: 'billing-api-orders-db-prod', env: { unknown: 'which environment?' } },
})

/**
 * The one plan here that did NOT come through the boundary, and the cast is the
 * point: `repair` is handed its plan by a callback it does not own, so gate [1]
 * is a real boundary rather than a formality. `draftPlan` cannot produce this —
 * which is exactly why the gate cannot be tested through it.
 */
const REFUSED_BY_ZOD = {
  intent: INTENT,
  operations: [
    { op: 'create-entity', entity: { ...ACCESS, spec: { ...ACCESS.spec, owner: 'tiger' } } },
  ],
} as unknown as Plan

/**
 * The Architect, replaced by the only thing the loop depends on: something that
 * returns a draft and remembers what it was told. Successive calls take
 * successive plans, and the last one repeats — "the model never fixes it" is
 * one argument, not three.
 */
const drafting = (
  ...plans: readonly (Plan | undefined)[]
): { draft: RepairInput['draft']; reports: (string | undefined)[] } => {
  const reports: (string | undefined)[] = []
  return {
    reports,
    draft: async (report: string | undefined): Promise<ArchitectOutcome> => {
      const plan = plans[Math.min(reports.length, plans.length - 1)]
      reports.push(report)
      return { plan, truncated: 0, rejections: 0 }
    },
  }
}

/** The Reviewer, likewise — and it counts, because its verdict costs a round-trip. */
const reviewing = (verdict: Verdict): { review: RepairInput['review']; seen: Plan[] } => {
  const seen: Plan[] = []
  return {
    seen,
    review: async (plan: Plan): Promise<Verdict> => {
      seen.push(plan)
      return verdict
    },
  }
}

const inputs = (over: Partial<RepairInput> = {}): RepairInput => ({
  intent: INTENT,
  draft: drafting(PLAN).draft,
  review: reviewing({ verdict: 'ok' }).review,
  signature: signature(),
  policy: policy(),
  snapshot: SNAPSHOT,
  contents: bytesOf(SNAPSHOT),
  ...over,
})

const ORDER: Gate[] = ['zod', 'signature', 'policy', 'reviewer', 'recheck']

describe('the five gates of §6.1', () => {
  it('runs all five, in the order the design fixes, on a plan that passes', async () => {
    const { events, emit } = collect()

    const outcome = planned(await repair(inputs(), emit))

    // The order OBSERVED, not the order written: the record is appended by each
    // gate as it runs, so a re-ordering of the source is a failing test.
    expect(outcome.attempts[0]?.gates).toEqual(ORDER)
    expect(outcome.attempts).toHaveLength(1)
    expect(eventsOfType(events, 'repair')).toEqual([])
  })

  it('offers the diff the gates approved, and only the files it touches', async () => {
    const { emit } = collect()

    const outcome = planned(await repair(inputs(), emit))

    expect(outcome.edits.map((edit) => edit.path)).toEqual([
      'dependencies/access/billing-api-orders-db-prod.yml',
    ])
    expect(outcome.dropped).toEqual([])
    expect(outcome.recheck.outcomes.get(0)).toBe('fresh')
    expect(outcome.recheck.violations).toEqual([])
  })

  it('stops at the gate that refused and runs none of the ones after it', async () => {
    const { emit } = collect()
    const reviewer = reviewing({ verdict: 'ok' })

    const outcome = stopped(
      await repair(inputs({ intent: DEV_INTENT, draft: drafting(MISMATCHED).draft, review: reviewer.review }), emit),
    )

    expect(outcome.attempts[0]?.gates).toEqual(['zod', 'signature', 'policy'])
    // The ordering §6.1 fixes is what buys this: three free gates first, so a
    // plan already known to be wrong never costs a round-trip.
    expect(reviewer.seen).toEqual([])
  })
})

describe('each gate refuses on its own', () => {
  it('[1] zod refuses a plan the schema would not have minted', async () => {
    const { events, emit } = collect()
    const architect = drafting(REFUSED_BY_ZOD)

    const outcome = stopped(await repair(inputs({ draft: architect.draft }), emit))

    expect(outcome.attempts[0]?.gates).toEqual(['zod'])
    expect(outcome.gate).toBe('zod')
    expect(eventsOfType(events, 'repair')[0]?.gate).toBe('zod')
  })

  it('[2] never has to file a name gate [1] would have refused', () => {
    // The signature refuses a name it cannot turn into a path. Every such name
    // is one `proposedName` already rejects, so the refusal is unreachable from
    // a plan that cleared gate [1] — which is what running zod first buys, and
    // the reason this is asserted as a pair rather than driven through `repair`.
    for (const name of ['../evil', '.hidden', 'a/b', 'a\\b', '']) {
      expect(() => computeEntityPath('database-access', name)).toThrow()
      expect(() => planOf({ ...ACCESS, metadata: { name, env: 'prod' } })).toThrow()
    }
  })

  it('[3] a policy refuses an environment the request never named', async () => {
    const { events, emit } = collect()

    const outcome = stopped(await repair(inputs({ intent: DEV_INTENT, draft: drafting(MISMATCHED).draft }), emit))

    expect(outcome.gate).toBe('policy')
    expect(eventsOfType(events, 'repair')[0]?.reason).toContain('environment-mismatch')
  })

  it('[4] the Reviewer refuses what every deterministic gate accepted', async () => {
    const { events, emit } = collect()
    const reviewer = reviewing({ verdict: 'reject', reason: 'this grants more than was asked' })

    const outcome = stopped(await repair(inputs({ review: reviewer.review }), emit))

    expect(outcome.attempts[0]?.gates).toEqual(['zod', 'signature', 'policy', 'reviewer'])
    expect(outcome.gate).toBe('reviewer')
    expect(eventsOfType(events, 'repair')[0]?.reason).toContain('this grants more than was asked')
    // It is handed the plan the free gates signed, never the draft as it arrived.
    expect(reviewer.seen[0]).toEqual(PLAN)
    expect(reviewer.seen).toHaveLength(REPAIR_LIMITS.maxAttempts)
  })

  it('[5] the re-check refuses a plan the repository has overtaken', async () => {
    // §4.4: the catalogue lags the repository by about two minutes, so the
    // entity may have appeared meanwhile — and somewhere else.
    const elsewhere: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: 'billing-api-orders-db-prod',
        annotations: {
          [ENV_ANNOTATION]: 'prod',
          [SOURCE_FILE_ANNOTATION]: 'dependencies/access/legacy-grant.yml',
        },
      },
      spec: {
        type: 'database-access',
        owner: 'group:default/tiger',
        dependsOn: ['resource:default/orders-db-prod'],
      },
    }
    const overtaken: RepositorySnapshot = {
      ...SNAPSHOT,
      files: [...SNAPSHOT.files, fileHolding('dependencies/access/legacy-grant.yml', elsewhere)],
    }
    const { events, emit } = collect()

    const outcome = stopped(
      await repair(inputs({ snapshot: overtaken, contents: bytesOf(overtaken) }), emit),
    )

    expect(outcome.attempts[0]?.gates).toEqual(ORDER)
    expect(outcome.gate).toBe('recheck')
    expect(eventsOfType(events, 'repair')[0]?.reason).toContain('duplicate-name')
  })
})

describe('the report handed back to the Architect', () => {
  it('carries the engine’s own dotted path, never a paraphrase of it', async () => {
    const { emit } = collect()
    const architect = drafting(MISMATCHED)

    await repair(inputs({ intent: DEV_INTENT, draft: architect.draft }), emit)

    // The same string a human reads and `findUnknowns` produces. A model
    // repairing a paraphrase is repairing something else.
    expect(architect.reports[1]).toContain('operations.0.entity.metadata')
    expect(architect.reports[1]).toContain('An environment is never inferred.')
  })

  it('tells the first attempt nothing, because there is nothing yet to fix', async () => {
    const { emit } = collect()
    const architect = drafting(PLAN)

    await repair(inputs({ draft: architect.draft }), emit)

    expect(architect.reports).toEqual([undefined])
  })
})

describe('three attempts, then a clean stop', () => {
  it('drafts three times and no more', async () => {
    const { events, emit } = collect()
    const architect = drafting(MISMATCHED)

    const outcome = stopped(await repair(inputs({ intent: DEV_INTENT, draft: architect.draft }), emit))

    expect(architect.reports).toHaveLength(REPAIR_LIMITS.maxAttempts)
    expect(outcome.attempts).toHaveLength(REPAIR_LIMITS.maxAttempts)
    expect(eventsOfType(events, 'repair').map((event) => event.attempt)).toEqual([1, 2, 3])
  })

  it('shows the partial plan with the reason, and signs nothing', async () => {
    const { emit } = collect()
    const architect = drafting(MISMATCHED)

    const outcome = stopped(await repair(inputs({ intent: DEV_INTENT, draft: architect.draft }), emit))

    // §6.1: the partial plan is shown with the reason. It is a Plan and not a
    // SignedPlan, and the absence is structural — there is no field to put one
    // in, so a caller cannot mistake this for something that may be written.
    expect(outcome.plan).toEqual(MISMATCHED)
    expect('signed' in outcome).toBe(false)
    expect(outcome.reason).toContain('policy')
  })

  it('leaves the bytes it was handed exactly as they were', async () => {
    const before = bytesOf(SNAPSHOT)
    const { emit } = collect()

    await repair(inputs({ intent: DEV_INTENT, draft: drafting(MISMATCHED).draft, contents: before }), emit)

    // "No file is written" starts one step earlier than the disk: nothing here
    // may even edit the buffers the caller owns.
    expect(before).toEqual(bytesOf(SNAPSHOT))
  })

  it('counts the attempt the second draft got right', async () => {
    const { events, emit } = collect()
    // First draft is refused, second is not.
    const architect = drafting(MISMATCHED, DEV_PLAN)

    const outcome = planned(
      await repair(inputs({ intent: DEV_INTENT, draft: architect.draft }), emit),
    )

    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0]?.failed).toBe('policy')
    expect(outcome.attempts[1]?.failed).toBeUndefined()
    expect(eventsOfType(events, 'repair')).toHaveLength(1)
  })
})

describe('a question is not a failed gate', () => {
  it('exits on the questions the signer asked, without spending an attempt', async () => {
    const { events, emit } = collect()
    const architect = drafting(UNVOUCHED)
    const reviewer = reviewing({ verdict: 'ok' })

    const outcome = asking(
      await repair(inputs({ draft: architect.draft, review: reviewer.review }), emit),
    )

    // No model can repair this: the value is one only the user holds, so design
    // 7.5 has the CLI ask. Handing it back would burn three paid attempts
    // asking the Architect to invent exactly what it is forbidden to invent.
    expect(outcome.questions.map((question) => question.path)).toEqual([
      'operations.0.entity.spec.owner',
    ])
    expect(architect.reports).toEqual([undefined])
    expect(reviewer.seen).toEqual([])
    expect(eventsOfType(events, 'repair')).toEqual([])
  })

  it('exits the same way on a question the model asked itself', async () => {
    const { events, emit } = collect()
    const architect = drafting(ASKED)

    const outcome = asking(await repair(inputs({ draft: architect.draft }), emit))

    expect(outcome.questions.map((question) => question.path)).toEqual([
      'operations.0.entity.metadata.env',
    ])
    expect(outcome.attempts[0]?.gates).toEqual(['zod', 'signature', 'policy'])
    expect(architect.reports).toEqual([undefined])
    expect(eventsOfType(events, 'ask')).toHaveLength(1)
  })
})

describe('when the Architect drafted nothing', () => {
  it('stops without calling it a repair', async () => {
    const { events, emit } = collect()
    const architect = drafting(undefined)

    const outcome = stopped(await repair(inputs({ draft: architect.draft }), emit))

    // No gate ran, because there was nothing to run one on — and `draftPlan`
    // has already emitted its own `refused` on this sink. A `repair` event here
    // would report that failure twice, under a name promising a correction.
    expect(outcome.plan).toBeUndefined()
    expect(outcome.attempts[0]?.gates).toEqual([])
    expect(architect.reports).toHaveLength(1)
    expect(eventsOfType(events, 'repair')).toEqual([])
  })
})

/**
 * The two callbacks, filled with the real agents driven by scripted turns. The
 * tests above prove the gates; this proves the shape the gates are wired into
 * is the shape `draftPlan` and `reviewPlan` actually have.
 */
describe('wired to the agents it calls back into', () => {
  const FACTS: ProjectFacts = {
    name: 'billing-api',
    type: 'service',
    lifecycle: 'production',
    runtime: 'node',
    owner: 'group:default/tiger',
    forgeHandle: { unknown: 'this repository has no CODEOWNERS' },
    dependencies: [{ name: 'orders-db', type: 'database' }],
  }

  it('signs and previews a plan drafted and reviewed without a model', async () => {
    const { events, emit } = collect()
    const tools = buildTools(EntityGraph.from([ORDERS_DB, BILLING_API]))
    const architect = scripted([
      turnCalling('search_entities', { env: 'prod' }),
      turnCalling(PROPOSE_TOOL, { operations: [{ op: 'create-entity', entity: ACCESS }] }),
    ])
    const reviewer = scripted([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])

    const outcome = planned(
      await repair(
        inputs({
          // `witnessed` is the live set the read tools fill, which is how the
          // CLI wires it: what the engine returned, never what the model wrote.
          signature: signature({ witnessed: tools.witnessed }),
          draft: () =>
            draftPlan(
              architect,
              tools,
              { intent: INTENT, facts: FACTS, summary: 'si:\n  entities: 2', vocabulary: '' },
              emit,
            ),
          review: (plan) => reviewPlan(reviewer, { plan, intent: INTENT }, emit),
        }),
        emit,
      ),
    )

    expect(outcome.attempts[0]?.gates).toEqual(ORDER)
    expect(outcome.edits).toHaveLength(1)
    expect(events.map((event) => event.type)).toContain('plan:ready')
  })
})

describe('a question is not a way out of a gate', () => {
  it('still refuses a policy violation when the plan also carries a question', async () => {
    // The escape this ordering closes. A question ends the run, so an Architect
    // failing a hard gate could convert a refusal into a question by emitting
    // one `{unknown}` anywhere — and the loop would stop asking it to try
    // again, while the user was handed a question about a plan the policy gate
    // would have refused outright.
    const both = planOf(
      {
        ...ACCESS,
        metadata: { name: 'billing-api-orders-db-prod', env: 'dev' },
        spec: { ...ACCESS.spec, owner: { unknown: 'which team owns this?' } },
      },
      DEV_INTENT,
    )
    const architect = drafting(both)
    const { emit } = collect()

    const outcome = await repair(inputs({ intent: DEV_INTENT, draft: architect.draft }), emit)

    expect(outcome.outcome).toBe('stopped')
    expect(stopped(outcome).gate).toBe('policy')
    // And it was handed back three times, rather than exiting on the question.
    expect(outcome.attempts).toHaveLength(REPAIR_LIMITS.maxAttempts)
  })

  it('runs the free gates before letting a question end the run', async () => {
    const architect = drafting(ASKED)
    const { emit } = collect()

    const outcome = asking(await repair(inputs({ draft: architect.draft }), emit))

    // policy ran and passed; nothing that costs a round-trip did.
    expect(outcome.attempts[0]?.gates).toEqual(['zod', 'signature', 'policy'])
  })
})

describe('the request is the caller’s, not the draft’s', () => {
  it('signs against the intent it was given, never the one the draft carries', async () => {
    // The signature measures provenance against the intent: a value appearing
    // in it is `echoed`, the strongest claim a value can carry. `plan.intent`
    // arrives from the same callback as the plan, so a drafter that wrote its
    // own could name the owner it wanted to propose and have the gate vouch
    // for it — an invented team, through all five gates, as though the user
    // had asked for it by name.
    const forged = planOf(
      { ...ACCESS, spec: { ...ACCESS.spec, owner: 'group:default/wizards' } },
      'give billing-api access to orders-db in prod owned by group:default/wizards',
    )
    const { emit } = collect()

    const outcome = await repair(inputs({ draft: drafting(forged).draft }), emit)

    // The caller asked for no such owner, so nothing vouches for it: a
    // question, not a value that slipped through on its own say-so.
    expect(outcome.outcome).toBe('questions')
    expect(asking(outcome).questions.map((one) => one.path)).toContain(
      'operations.0.entity.spec.owner',
    )
  })
})

describe('what the Architect counted does not die at the seam', () => {
  it('carries truncated and rejections out of every outcome', async () => {
    // The Architect counts these FOR ITS CALLER: rows its tools cut off, and
    // proposals its own schema refused. A plan drafted on a partial view of
    // the catalogue looks exactly like one drafted on all of it, and this is
    // the seam where the signal was being read and dropped.
    const noisy: RepairInput['draft'] = async () => ({
      plan: PLAN,
      truncated: 7,
      rejections: 2,
    })
    const { emit } = collect()

    const outcome = await repair(inputs({ draft: noisy }), emit)

    expect(outcome.truncated).toBe(7)
    expect(outcome.rejections).toBe(2)
  })

  it('keeps the refusal an earlier attempt recorded when a later draft comes back empty', async () => {
    // A second attempt producing no draft at all does not un-refuse the first
    // one, and `plan` still carries the partial plan a gate judged. Returning
    // "there was nothing to judge" beside it said two things that could not
    // both be true.
    let call = 0
    const thenNothing: RepairInput['draft'] = async () => {
      call += 1
      return call === 1
        ? { plan: MISMATCHED, truncated: 0, rejections: 0 }
        : { plan: undefined, truncated: 0, rejections: 0 }
    }
    const { emit } = collect()

    const outcome = stopped(
      await repair(inputs({ intent: DEV_INTENT, draft: thenNothing }), emit),
    )

    expect(outcome.gate).toBe('policy')
    expect(outcome.reason).toContain('policy')
    expect(outcome.plan).toEqual(MISMATCHED)
  })
})
