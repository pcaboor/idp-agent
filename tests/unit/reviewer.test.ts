import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../../src/agents/events.js'
import { MAX_REPAIRS } from '../../src/agents/forced-turn.js'
import {
  REVIEWER_LIMITS,
  VERDICT_TOOL,
  reviewPlan,
  verdictSchema,
} from '../../src/agents/reviewer.js'
import { planSchema, type Plan } from '../../src/core/schemas/plan.js'
import { QUERY_LIMITS } from '../../src/core/schemas/query.js'
import type {
  GenerateRequest,
  GenerateResult,
  LlmClient,
  ModelToolCall,
} from '../../src/llm/client.js'

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

/** The same replay, keeping every request so a test can assert what the model was told. */
const capturing = (turns: GenerateResult[]): LlmClient & { seen: GenerateRequest[] } => {
  const client = {
    seen: [] as GenerateRequest[],
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      client.seen.push(request)
      return turns[client.seen.length - 1] ?? { text: '', toolCalls: [], finishReason: 'stop' }
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
const saying = (text: string): GenerateResult => ({ text, toolCalls: [], finishReason: 'stop' })

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

const INTENT = 'give billing-api read access to orders-db in prod'

/** The access declaration a sound draft proposes. */
const ACCESS = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access', access: 'read',
      owner: 'group:default/platform',
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
}

/** The other half of design 7.4's branch: the existing resource gains a consumer. */
const LINK = {
  op: 'update-entity',
  entityRef: 'resource:default/orders-db-prod',
  patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api' },
}

/**
 * Parsed, not written out as a literal: `reviewPlan` is only ever handed a plan
 * that came through the boundary, and a fixture the schema would refuse would
 * test the Reviewer against a plan that cannot exist.
 */
const PLAN: Plan = planSchema.parse({ intent: INTENT, operations: [ACCESS, LINK] })

/**
 * The bytes a provider would be handed, for every request the run made.
 *
 * A `ModelToolSpec` carries a `ZodType`, which is not what crosses the wire —
 * its JSON Schema is, and that is where a field name would hide. So the schema
 * is converted rather than skipped: a test that asserted on the transcript
 * alone would miss anything smuggled through a tool description or a property
 * name.
 */
const sentTo = (client: { seen: GenerateRequest[] }): string =>
  JSON.stringify(
    client.seen.map((request) => ({
      system: request.system,
      transcript: request.transcript,
      toolChoice: request.toolChoice,
      tools: request.tools.map((spec) => ({
        name: spec.name,
        description: spec.description,
        parameters: z.toJSONSchema(spec.parameters, { io: 'input' }),
      })),
    })),
  )

const reasonOf = (event: AgentEvent | undefined): string =>
  event && 'reason' in event ? event.reason : ''

describe('verdictSchema', () => {
  it('carries the refusal as a member of the union, the way an Answer does', () => {
    // A model with no legal way to object invents a defect to stay in schema —
    // and this verdict blocks, so an invented defect stops a sound plan.
    expect(verdictSchema.safeParse({ verdict: 'ok' }).success).toBe(true)
    expect(
      verdictSchema.safeParse({ verdict: 'reject', reason: 'the request named dev' }).success,
    ).toBe(true)
    // A rejection with no reason is a veto nobody can act on.
    expect(verdictSchema.safeParse({ verdict: 'reject' }).success).toBe(false)
    expect(verdictSchema.safeParse({ verdict: 'reject', reason: '' }).success).toBe(false)
    expect(verdictSchema.safeParse({ verdict: 'unsure', reason: 'hm' }).success).toBe(false)
  })

  it('bounds the reason, like every other string a model writes here', () => {
    const ceiling = 'x'.repeat(QUERY_LIMITS.maxReason)
    expect(verdictSchema.safeParse({ verdict: 'reject', reason: ceiling }).success).toBe(true)
    expect(verdictSchema.safeParse({ verdict: 'reject', reason: `${ceiling}x` }).success).toBe(
      false,
    )
  })
})

describe('the Reviewer is not an echo', () => {
  it('shows the reviewer the original request, never the architect transcript', async () => {
    // The Architect and the Reviewer are the same weights behind the same
    // provider: their errors are correlated by construction. Feeding it the
    // Architect's own reasoning turns a second opinion into an echo — and this
    // one holds a veto.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, () => {})

    const sent = sentTo(client).toLowerCase()
    expect(client.seen).toHaveLength(1)
    expect(sent).toContain(INTENT)
    expect(sent).not.toContain('architect')
    expect(sent).not.toContain('attempt')
  })

  it('offers one tool, and it is the terminal one', async () => {
    // "The Plan and the original request, nothing else" is a statement about
    // the tools too: a read tool is one more channel for something that is not
    // the plan to reach the gate that can veto it.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, () => {})

    expect(client.seen.map((request) => request.tools.map((spec) => spec.name))).toEqual([
      [VERDICT_TOOL],
    ])
  })

  it('puts every operation the plan would apply in front of it', async () => {
    // The gate reads what the plan DOES. A message that summarised the
    // operations would be one field away from hiding the field that matters —
    // an environment nobody named is a line in an operation.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, () => {})

    const sent = sentTo(client)
    expect(sent).toContain('billing-api-orders-db-prod')
    expect(sent).toContain('resource:default/orders-db-prod')
    expect(sent).toContain('add-dependency-of')
  })
})

/** The same request, narrowed to the field this gate now exists to police. */
const READ_INTENT = 'give billing-api read access to orders-db in prod'

/**
 * A grant wider than the request asked for.
 *
 * Parsed like every other fixture here, and the parse is half the point: a
 * level is a field of the proposal boundary, so this is a plan the drafting
 * agent can actually produce and gates [1] to [3] actually pass. `readwrite`
 * is a member of the enum, so the schema accepts it; it is not a question, so
 * the signature is done with it. Nothing before this gate can object.
 */
const WIDER: Plan = planSchema.parse({
  intent: READ_INTENT,
  operations: [
    {
      ...ACCESS,
      entity: {
        ...ACCESS.entity,
        spec: { ...ACCESS.entity.spec, access: 'readwrite' },
      },
    },
  ],
})

/** The plan whose owner the request never names, with the owner the engine computed. */
const DERIVED_OWNER = 'group:default/tiger'
const DERIVED_PLAN: Plan = planSchema.parse({
  intent: INTENT,
  operations: [
    {
      ...ACCESS,
      entity: { ...ACCESS.entity, spec: { ...ACCESS.entity.spec, owner: DERIVED_OWNER } },
    },
  ],
})

/** What `deriveOwners` returns for it: a fact, in the shape `opening` renders. */
const DERIVED = [
  {
    path: 'operations.0.entity.spec.owner',
    owner: DERIVED_OWNER,
    from: ['component:default/billing-api'],
  },
]

/**
 * The system prompt of the first request, on one line and in one case.
 *
 * The prompt is hard-wrapped to be read in the file, so a rule that straddles a
 * line break is the same rule; an assertion that broke on a re-wrap would be
 * measuring the margin rather than what the model was told.
 */
const toldTo = (client: { seen: GenerateRequest[] }): string =>
  (client.seen[0]?.system ?? '').toLowerCase().replace(/\s+/g, ' ')

describe('what this gate judges', () => {
  it('rejects a plan granting readwrite for a request that asked for read', async () => {
    // Design 6: perfectly valid YAML can answer the wrong question. This is
    // that question with a field behind it — write where read was asked for
    // is expressible, vouched for, and not what the user asked.
    //
    // What a scripted client CANNOT show is that a model would reject it: no
    // stub decides anything. What it does show is the two halves that are this
    // file's to keep — the level is in front of the model at all, and a
    // rejection blocks and is audible.
    const reason = 'the request asked for read access, and the plan grants readwrite'
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'reject', reason })])
    const { events, emit } = collect()

    expect(
      await reviewPlan(client, { plan: WIDER, intent: READ_INTENT, derived: [], targets: [], effects: [] }, emit),
    ).toEqual({ verdict: 'reject', reason })
    expect(sentTo(client)).toContain('readwrite')
    expect(events.find((event) => event.type === 'refused')).toEqual({
      type: 'refused',
      agent: 'reviewer',
      reason,
    })
  })

  it('is told what the repository says about the grant an update would extend', async () => {
    // F9: an update names its target by REFERENCE and carries no entity, so
    // the operations JSON for one is `{op, entityRef, patch}` and nothing
    // more. Asked "is this what was requested" about a grant whose level,
    // environment, owner and current holders it cannot see, the Reviewer was
    // judging an authorisation with the authorisation withheld — and an
    // `add-dependency-of` hands over exactly those facts.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])

    await reviewPlan(
      client,
      {
        plan: PLAN,
        intent: INTENT,
        derived: [],
        targets: [
          {
            opIndex: 0,
            entityRef: 'resource:default/billing-api-orders-db-prod',
            level: 'readwrite',
            environment: 'prod',
            owner: 'group:default/tiger',
            consumers: ['component:default/checkout-web'],
          },
        ],
        effects: [],
      },
      () => {},
    )

    const sent = sentTo(client)
    expect(sent).toContain('it grants readwrite')
    expect(sent).toContain('it is scoped to prod')
    expect(sent).toContain('group:default/tiger owns it')
    expect(sent).toContain('already held by component:default/checkout-web')
  })

  it('is told when an operation would change nothing at all', async () => {
    // The other half of F9. This gate used to run BEFORE the preview existed,
    // so it could approve a plan whose only operation produces no bytes —
    // which is what an "empty diff, exit 0" run is. F10 moved the free gate
    // first so these facts exist by the time this one runs; this is what that
    // bought, and an operation that changes nothing is the difference between
    // a request satisfied and a request silently ignored.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])

    await reviewPlan(
      client,
      {
        plan: PLAN,
        intent: INTENT,
        derived: [],
        targets: [],
        effects: [{ opIndex: 0, effect: 'changes nothing: the repository already declares it' }],
      },
      () => {},
    )

    expect(sentTo(client)).toContain('operations.0 changes nothing')
  })

  it('says nothing about facts it was given none of', async () => {
    // A plan of creations targets no existing entity, so there is no line
    // about one. An empty section is left out rather than printed as a
    // heading with nothing under it: a reviewer reading "what is already
    // declared:" followed by nothing has been told something false.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])

    await reviewPlan(
      client,
      { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] },
      () => {},
    )

    expect(sentTo(client)).not.toContain('already declared about')
    expect(sentTo(client)).not.toContain('what each operation would do')
  })

  it('is told to judge all of what was asked, and nothing beyond it', async () => {
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, () => {})

    const system = toldTo(client)
    expect(system).toContain('all of it, and nothing more')
    // The three shapes of the mismatch, named so the model has something to
    // look for other than a defect it invents to have something to say.
    expect(system).toContain('where read was asked for')
    expect(system).toContain('the request never mentioned')
    expect(system).toContain('half of what was asked')
  })

  it('does not re-litigate where a value came from', async () => {
    // The refusal this rewrite exists to stop: three attempts a run, every
    // run, on a field an earlier gate had already settled — sometimes one the
    // engine DERIVED outright from the consumer (`core/plan/derive.ts`), which
    // makes the objection a refusal of arithmetic.
    //
    // A stub decides nothing, so what is asserted is what the model is TOLD:
    // the engine's line about that owner reaches it as fact, and the prompt
    // rules the provenance question out in the terms the refusal used.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    const { emit } = collect()

    expect(
      await reviewPlan(client, { plan: DERIVED_PLAN, intent: INTENT, derived: DERIVED, targets: [], effects: [] }, emit),
    ).toEqual({ verdict: 'ok' })

    const sent = sentTo(client)
    expect(sent).toContain(DERIVED_OWNER)
    expect(sent).toContain('component:default/billing-api')

    const system = toldTo(client)
    expect(system).toContain('where a value came from')
    expect(system).toContain('refusing an owner because the request did not name it')
    // The four answers gate [2] gives, so "already accounted for" is a claim
    // the model can check rather than a slogan it has to take on faith.
    expect(system).toContain('appears in the request')
    expect(system).toContain('the catalogue already uses')
    expect(system).toContain('a rule the engine applied')
    expect(system).toContain('already been turned into a question')
  })

  it('names the environment, the folder and the path as settled elsewhere', async () => {
    // Each has its own deterministic gate — the environment policy, the
    // unwitnessed-folder policy, and the engine computing the path from the
    // type and the name (design 5.2). A second opinion re-checking them costs
    // a paid attempt to restate what ran for free.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, () => {})

    const system = toldTo(client)
    expect(system).toContain('do not re-check')
    expect(system).toContain('environment')
    expect(system).toContain('folder')
    expect(system).toContain('path')
  })

  it('still says nothing of the transcript, the attempt or the gate before it', async () => {
    // The independence rule survives the rewrite. Naming which gate settled
    // what would be the earlier gate's reasoning arriving by another door, and
    // this gate holds a veto over the agent whose reasoning it would be.
    const client = capturing([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    await reviewPlan(client, { plan: DERIVED_PLAN, intent: INTENT, derived: DERIVED, targets: [], effects: [] }, () => {})

    const system = toldTo(client)
    for (const leak of ['architect', 'attempt', 'repair', 'violation', 'signature', 'policy']) {
      expect(system).not.toContain(leak)
    }
    // One message, the opening, and nothing before it. Asserted on the first
    // entry rather than on the length: `capturing` keeps the live array, which
    // the loop appends the model's own turn to once the call comes back.
    const first = client.seen[0]?.transcript[0]
    expect(first?.role).toBe('user')
    expect(first && 'text' in first ? first.text : '').toContain(`request: ${INTENT}`)
    expect(client.seen).toHaveLength(1)
  })
})

describe('reviewPlan', () => {
  it('returns the verdict the model gave through the verdict tool', async () => {
    const client = scripted([turnCalling(VERDICT_TOOL, { verdict: 'ok' })])
    const { events, emit } = collect()

    expect(await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)).toEqual({
      verdict: 'ok',
    })
    expect(client.calls).toBe(1)
    // Nothing else on the sink: the union has no verdict event, and a plan that
    // cleared this gate is reported by the gate after it.
    expect(events.map((event) => event.type)).toEqual(['agent:start'])
  })

  it('stops the plan when the reviewer rejects', async () => {
    // Blocking, by decision (design 6.1, gate [3]). A rejection is not a
    // caveat, so it comes back as the verdict AND it is audible: a run that
    // ends with no diff has to say which gate ended it.
    const reason = 'the request named prod, and the plan opens dev as well'
    const client = scripted([turnCalling(VERDICT_TOOL, { verdict: 'reject', reason })])
    const { events, emit } = collect()

    expect(await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)).toEqual({
      verdict: 'reject',
      reason,
    })
    expect(events.find((event) => event.type === 'refused')).toEqual({
      type: 'refused',
      agent: 'reviewer',
      reason,
    })
  })

  it('hands a malformed verdict back for repair rather than failing the review', async () => {
    const client = scripted([
      turnCalling(VERDICT_TOOL, { verdict: 'reject' }),
      turnCalling(VERDICT_TOOL, { verdict: 'ok' }),
    ])
    const { events, emit } = collect()

    expect(await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)).toEqual({
      verdict: 'ok',
    })
    expect(client.calls).toBe(2)
    // `retry`, not `repair`: an agent correcting its own malformed terminal
    // call is a different fact from an attempt of the repair loop, and they
    // used to share a field — two counters under one name, the inner one
    // restarting inside every attempt of the outer.
    const retry = events.find((event) => event.type === 'retry')
    expect(retry && 'agent' in retry ? retry.agent : '').toBe('reviewer')
    // The error names the field, which is what makes the correction possible.
    expect(reasonOf(retry)).toContain('reason')
  })

  it('refuses a rejection reason past the ceiling and hands that back too', async () => {
    const overlong = 'x'.repeat(QUERY_LIMITS.maxReason + 1)
    const reason = 'the plan opens an environment the request never named'
    const client = scripted([
      turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: overlong }),
      turnCalling(VERDICT_TOOL, { verdict: 'reject', reason }),
    ])
    const { events, emit } = collect()

    expect(await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)).toEqual({
      verdict: 'reject',
      reason,
    })
    expect(events.some((event) => event.type === 'retry')).toBe(true)
  })

  it('stops granting turns back once the repair bound is spent', async () => {
    const client = scripted(
      Array.from({ length: 20 }, () => turnCalling(VERDICT_TOOL, { verdict: 'reject' })),
    )
    const { emit } = collect()

    const verdict = await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)

    expect(client.calls).toBe(REVIEWER_LIMITS.maxTurns + MAX_REPAIRS)
    // Twenty malformed verdicts are not twenty rejections: no verdict ever
    // parsed, so no one reviewed this plan, and saying "rejected" would be
    // reporting a judgement nobody made.
    expect(verdict.verdict).toBe('no-opinion')
  })

  it('degrades to an open tool choice when the provider rejects a forced one', async () => {
    // Forcing a tool is model-dependent: some reject it with a 400, and the SDK
    // throws when a forced call does not come back. Neither may take the review
    // down with it — and a review that is lost is a plan that is blocked.
    const seen: unknown[] = []
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request.toolChoice)
        if (typeof request.toolChoice === 'object') {
          throw new Error(
            `Model response did not contain a call to the required tool '${VERDICT_TOOL}'.`,
          )
        }
        return seen.length === 1
          ? saying('let me look at the operations first')
          : turnCalling(VERDICT_TOOL, { verdict: 'ok' })
      },
    }
    const { emit } = collect()

    expect(await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)).toEqual({
      verdict: 'ok',
    })
    expect(seen).toContainEqual({ tool: VERDICT_TOOL })
    expect(seen.filter((choice) => choice === 'auto')).toHaveLength(2)
  })
})

describe('a review that did not happen is not an approval', () => {
  it('returns no-opinion when the model never produces a verdict', async () => {
    // The direction is the decision. This gate blocks, so defaulting to "ok"
    // would make a run that got no second opinion indistinguishable from one
    // that got a favourable one.
    const client = scripted([saying('the plan seems reasonable to me')])
    const { events, emit } = collect()

    const verdict = await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)
    // Its OWN member of the union, not a flavour of rejection. Collapsed into
    // `reject`, a review that never happened read as one that refused: the
    // repair loop spent all three paid attempts on a plan nobody had found
    // fault with, and told the user it was refused.
    expect(verdict.verdict).toBe('no-opinion')
    expect(client.calls).toBe(REVIEWER_LIMITS.maxTurns)
    expect(events.some((event) => event.type === 'refused')).toBe(true)
    // It keeps what the model said, which is the only account of why.
    expect(verdict.verdict === 'no-opinion' ? verdict.reason : '').toContain(
      'the plan seems reasonable to me',
    )
  })

  it('bounds the reason it writes itself, like every other string here', async () => {
    const client = scripted([saying('x'.repeat(5_000))])
    const { emit } = collect()

    const verdict = await reviewPlan(client, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)

    expect(verdict.verdict).toBe('no-opinion')
    const reason = 'reason' in verdict ? verdict.reason : ''
    expect(reason.length).toBeLessThanOrEqual(QUERY_LIMITS.maxReason)
  })

  it('closes the event stream before letting a provider failure through', async () => {
    // Not swallowed: a caller is owed the difference between "the plan was
    // rejected" and "no opinion was obtained" — both stop the plan, and only
    // one of them is about the plan. But `agent:start` is already on the sink,
    // so the stream is closed before the rejection propagates.
    const exploding: LlmClient = {
      generate: () => Promise.reject(new Error('502 from the gateway')),
    }
    const { events, emit } = collect()

    await expect(reviewPlan(exploding, { plan: PLAN, intent: INTENT, derived: [], targets: [], effects: [] }, emit)).rejects.toThrow('502')

    expect(events.map((event) => event.type)).toEqual(['agent:start', 'refused'])
    expect(reasonOf(events.find((event) => event.type === 'refused'))).toContain('502')
  })
})
