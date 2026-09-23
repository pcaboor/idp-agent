import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ARCHITECT_LIMITS, draftPlan } from '../../src/agents/architect.js'
import { MAX_REPAIRS } from '../../src/agents/forced-turn.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { buildTools } from '../../src/agents/tools/graph-tools.js'
import type { ProjectFacts } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL, buildProposeTool } from '../../src/agents/tools/propose-tool.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { SOURCE_FILE_ANNOTATION, type Entity } from '../../src/core/schemas/entity.js'
import { operationSchema, planSchema } from '../../src/core/schemas/plan.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
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

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

/**
 * Two real entities behind the real graph tools, because the point of half these
 * tests is what the ENGINE returned as opposed to what the model wrote, and a
 * stubbed witness set cannot tell the two apart.
 *
 * Both carry the annotation that says which file they live in. Nothing the model
 * sees may carry it: the Architect chooses no path (design 5.2), and a file name
 * in a tool result is a path handed over by the back door.
 */
const ORDERS_DB: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: {
    name: 'orders-db-prod',
    annotations: {
      [ENV_ANNOTATION]: 'prod',
      [SOURCE_FILE_ANNOTATION]: 'catalog/databases/orders-db-prod.yml',
    },
  },
  spec: { type: 'database', owner: 'group:default/platform' },
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
  spec: {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:default/platform',
    dependsOn: ['resource:default/orders-db-prod'],
  },
}

/**
 * What the CLI will hand `draftPlan`: the catalogue reads, and not `answer` —
 * the Architect proposes, it does not answer (design 6). `witnessed` is the real
 * set the real tools fill.
 */
const readTools = (): ReturnType<typeof buildTools> => {
  const built = buildTools(EntityGraph.from([ORDERS_DB, BILLING_API]))
  return { ...built, specs: built.specs.filter((spec) => spec.name !== 'answer') }
}

const FACTS: ProjectFacts = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/platform',
  forgeHandle: { unknown: 'this repository has no CODEOWNERS' },
  dependencies: [{ name: 'orders-db', type: 'database' }],
}

const INPUT = {
  intent: 'give billing-api read access to orders-db in prod',
  facts: FACTS,
  summary: 'si:\n  entities: 2',
  vocabulary: 'vocabulary:\n  owners: group:default/platform',
}

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

const proposing = (operations: unknown[]): GenerateResult =>
  turnCalling(PROPOSE_TOOL, { operations })

/**
 * Every property name a model could write into, anywhere in a tool's declared
 * schema. Walked rather than read off the top level: a path field buried three
 * levels inside an operation is still a path field.
 */
const propertyNames = (schema: z.ZodType): string[] => {
  const names: string[] = []
  const stack: unknown[] = [z.toJSONSchema(schema, { io: 'input' })]

  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    if (typeof node !== 'object' || node === null) continue
    const record = node as Record<string, unknown>
    const properties = record['properties']
    if (typeof properties === 'object' && properties !== null) {
      names.push(...Object.keys(properties))
    }
    stack.push(...Object.values(record))
  }

  return names
}

/**
 * `repoPath`, `sourceFile`, `folder`, `root` — anything a location could be
 * written into.
 *
 * Matched on whole camel-case words and not on a substring: `direction`, the
 * argument that says which way `get_dependencies` walks, contains "dir" and is
 * an enum of three values. A rule that flagged it would be a rule people learn
 * to ignore.
 */
const PATH_WORD = /^(path|filepath|file|filename|folder|dir|directory|root|location)$/i
const isPathLike = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .some((word) => PATH_WORD.test(word))

describe('buildProposeTool', () => {
  it('returns nothing to the model when it accepts a proposal', () => {
    // The write side of design 10: one typed object crosses, and it crosses in
    // one direction. Not the plan, not a path, not "ok, 2 operations" — a model
    // that can read its own buffer back can be steered by what it reads.
    const propose = buildProposeTool()
    const outcome = propose.run(toolCall(PROPOSE_TOOL, { operations: [ACCESS, LINK] }))
    expect(outcome).toEqual({ result: {}, rows: 0, truncated: 0 })
    expect(JSON.stringify(outcome)).not.toContain('billing-api-orders-db-prod')
  })

  it('fills the buffer with the whole proposal, both operations intact', () => {
    const propose = buildProposeTool()
    propose.run(toolCall(PROPOSE_TOOL, { operations: [ACCESS, LINK] }))
    expect(propose.taken()?.operations).toEqual([ACCESS, LINK])
  })

  it('names the field a malformed proposal got wrong, so the model can repair it', () => {
    // plan.ts discriminates on `kind` precisely so a rejection can say which
    // field failed. A model told "invalid input" repairs at random.
    const propose = buildProposeTool()
    const broken = {
      ...ACCESS,
      entity: { ...ACCESS.entity, spec: { ...ACCESS.entity.spec, owner: 'tiger' } },
    }
    const outcome = propose.run(toolCall(PROPOSE_TOOL, { operations: [broken] }))
    expect(JSON.stringify(outcome.result)).toContain('operations.0.entity.spec.owner')
    expect(propose.taken()).toBeUndefined()
  })

  it('refuses the one operation that names a path, rather than trusting the model not to', () => {
    // `create-catalog-info` carries `repoPath`. It is a real operation and the
    // engine composes it for `init` (design 7.3); it is not one a model fills in.
    // Every other field here is sound on purpose: the only thing wrong with this
    // call is the operation it asks for.
    const propose = buildProposeTool()
    const outcome = propose.run(
      toolCall(PROPOSE_TOOL, {
        operations: [
          {
            op: 'create-catalog-info',
            repoPath: 'catalog-info.yml',
            entity: {
              kind: 'Component',
              metadata: { name: 'billing-api' },
              spec: {
                type: 'service',
                lifecycle: 'production',
                owner: 'group:default/platform',
              },
            },
          },
        ],
      }),
    )
    expect(JSON.stringify(outcome.result)).toContain('error')
    expect(propose.taken()).toBeUndefined()
  })

  it('has no field a path could be written into, anywhere in its schema', () => {
    // Half of design 5.2: the engine computes where a declaration is filed, from
    // its type and its name. The other half is that no tool returns one.
    const names = propertyNames(buildProposeTool().spec.parameters)
    expect(names.filter(isPathLike)).toEqual([])
    expect(names).toContain('operations')
  })

  it('narrows a union that really does carry a path, so the walk above is not vacuous', () => {
    // `operationSchema` holds `repoPath`, and the propose tool's narrowing is
    // the only reason it does not travel. If this ever returns [], the test
    // above has stopped proving anything.
    expect(propertyNames(operationSchema).filter(isPathLike)).toEqual(['repoPath'])
  })

  it('has no intent field, because the signer measures every value against the intent', () => {
    // `signPlan` classifies a value that appears in the request as `echoed`, and
    // `echoed` signs cleanly. A model that wrote its own intent would be writing
    // both sides of that comparison — "secret-backdoor" in the intent, and every
    // leaf vouches for itself. The request is the user's words.
    expect(propertyNames(buildProposeTool().spec.parameters)).not.toContain('intent')
  })

  it('witnesses nothing, because everything it sees came from the model', () => {
    // The witness set is what `signPlan` tests a proposed reference against. A
    // propose tool that recorded its own arguments would make the signature
    // vouch for exactly the inventions it exists to catch.
    const propose = buildProposeTool()
    propose.run(toolCall(PROPOSE_TOOL, { operations: [LINK] }))
    expect(propose.witnessed.size).toBe(0)
  })

  it('accepts an empty list, which is how "already declared" is said', () => {
    // Design 7.5: an entity that already exists yields an empty plan, exit 0.
    // A floor of one operation would make that outcome inexpressible, and an
    // inexpressible outcome is an invented one.
    const propose = buildProposeTool()
    expect(propose.run(toolCall(PROPOSE_TOOL, { operations: [] })).result).toEqual({})
    expect(propose.taken()?.operations).toEqual([])
  })

  it('keeps the first proposal and refuses a second rather than letting order decide', () => {
    const propose = buildProposeTool()
    propose.run(toolCall(PROPOSE_TOOL, { operations: [ACCESS] }))
    const second = propose.run(toolCall(PROPOSE_TOOL, { operations: [LINK] }))
    expect(JSON.stringify(second.result)).toContain('error')
    expect(propose.taken()?.operations).toEqual([ACCESS])
  })

  it('buffers something that is not yet a plan, and fails loudly if used as one', () => {
    // The intent is not the model's to write and the tool has no way to know it,
    // so the buffer carries an empty one and `planSchema` refuses it. A caller
    // that skips `draftPlan` fails at the boundary rather than signing a plan
    // against an intent nobody typed.
    const propose = buildProposeTool()
    propose.run(toolCall(PROPOSE_TOOL, { operations: [ACCESS] }))
    expect(propose.taken()?.intent).toBe('')
    expect(planSchema.safeParse(propose.taken()).success).toBe(false)
  })

  it('returns an error rather than throwing when it is handed another tool name', () => {
    expect(buildProposeTool().run(toolCall('who_knows', {})).result).toHaveProperty('error')
  })
})

describe('the Architect is never handed a path', () => {
  it('offers no tool whose schema has a field a path fits in', () => {
    const tools = readTools()
    const specs = [...tools.specs, buildProposeTool().spec]
    const named = specs.flatMap((spec) =>
      propertyNames(spec.parameters).filter(isPathLike),
    )
    expect(named).toEqual([])
  })

  it('returns no path from any tool it can call, including the annotation that holds one', () => {
    const tools = readTools()
    const propose = buildProposeTool()
    const shown = [
      tools.run(toolCall('search_entities', { type: 'database' })),
      tools.run(toolCall('get_entity', { ref: 'resource:default/orders-db-prod' })),
      tools.run(
        toolCall('get_dependencies', {
          ref: 'resource:default/orders-db-prod',
          direction: 'dependants',
        }),
      ),
      propose.run(toolCall(PROPOSE_TOOL, { operations: [ACCESS] })),
    ].map((outcome) => JSON.stringify(outcome.result))

    for (const output of shown) {
      expect(output).not.toContain(SOURCE_FILE_ANNOTATION)
      expect(output).not.toContain('catalog/')
      expect(output).not.toContain('.yml')
    }
  })

  it('puts no path in front of the model at any point in a draft', async () => {
    const client = capturing([
      turnCalling('search_entities', { type: 'database' }),
      proposing([ACCESS]),
    ])
    const { emit } = collect()
    await draftPlan(client, readTools(), INPUT, emit)
    const sent = JSON.stringify(client.seen)
    expect(sent).not.toContain(SOURCE_FILE_ANNOTATION)
    expect(sent).not.toContain('catalog/')
    expect(sent).not.toContain('.yml')
  })
})

describe('draftPlan', () => {
  it('returns the plan the model proposed, with both operations intact', async () => {
    const client = scripted([
      turnCalling('search_entities', { type: 'database', env: 'prod' }),
      proposing([ACCESS, LINK]),
    ])
    const { emit } = collect()
    const plan = (await draftPlan(client, readTools(), INPUT, emit)).plan
    expect(plan?.operations).toEqual([ACCESS, LINK])
    expect(planSchema.safeParse(plan).success).toBe(true)
  })

  it('carries the request as the plan intent, since no model wrote it', async () => {
    const client = scripted([proposing([ACCESS])])
    const { emit } = collect()
    expect(((await draftPlan(client, readTools(), INPUT, emit)).plan)?.intent).toBe(INPUT.intent)
  })

  it('keeps a proposal of no operations, rather than reading it as a failure', async () => {
    const client = scripted([proposing([])])
    const { emit } = collect()
    expect(((await draftPlan(client, readTools(), INPUT, emit)).plan)?.operations).toEqual([])
  })

  it('puts a malformed proposal back for correction and takes the second', async () => {
    // Same repair the Analyst makes for a malformed `answer`: the model gets to
    // correct itself rather than the whole draft ending on one bad call.
    const broken = {
      ...ACCESS,
      entity: { ...ACCESS.entity, spec: { ...ACCESS.entity.spec, owner: 'tiger' } },
    }
    const client = capturing([proposing([broken]), proposing([ACCESS])])
    const { emit } = collect()
    const plan = (await draftPlan(client, readTools(), INPUT, emit)).plan
    expect(plan?.operations).toEqual([ACCESS])
    expect(JSON.stringify(client.seen.at(-1)?.transcript)).toContain(
      'operations.0.entity.spec.owner',
    )
  })

  it('does not witness a reference the model invented, only the ones a tool returned', async () => {
    // The one thing the signature exists to prevent. `orders-db-prod` came back
    // from `search_entities`; `resource:default/invented` came out of the model,
    // and the plan carries it — unwitnessed, so `signPlan` asks about it rather
    // than vouching for it.
    const invented = { ...LINK, entityRef: 'resource:default/invented' }
    const tools = readTools()
    const client = scripted([
      turnCalling('search_entities', { type: 'database', env: 'prod' }),
      proposing([invented]),
    ])
    const { emit } = collect()
    const plan = (await draftPlan(client, tools, INPUT, emit)).plan
    expect(tools.witnessed.has('resource:default/orders-db-prod')).toBe(true)
    expect(tools.witnessed.has('resource:default/invented')).toBe(false)
    expect(JSON.stringify(plan)).toContain('resource:default/invented')
  })

  it('offers the model the reads it was given, plus one way to finish', async () => {
    const client = capturing([proposing([ACCESS])])
    const { emit } = collect()
    await draftPlan(client, readTools(), INPUT, emit)
    expect(client.seen[0]?.tools.map((spec) => spec.name)).toEqual([
      'search_entities',
      'get_entity',
      'get_dependencies',
      PROPOSE_TOOL,
    ])
  })

  it('tells the model the established facts, unknowns included', async () => {
    // An unknown that arrives as an absent field reads as a fact nobody needed.
    // `forgeHandle` is unknown here and the model has to be told so, or it
    // proposes an owner it has no evidence for.
    const client = capturing([proposing([ACCESS])])
    const { emit } = collect()
    await draftPlan(client, readTools(), INPUT, emit)
    const opening = JSON.stringify(client.seen[0]?.transcript[0])
    expect(opening).toContain(INPUT.intent)
    expect(opening).toContain('billing-api')
    expect(opening).toContain('this repository has no CODEOWNERS')
    expect(opening).toContain('orders-db')
  })

  it('stops at its turn bound and refuses rather than returning a partial plan', async () => {
    const client = scripted(
      Array.from({ length: 20 }, () =>
        turnCalling('search_entities', { type: 'database', env: 'prod' }),
      ),
    )
    const { events, emit } = collect()
    expect((await draftPlan(client, readTools(), INPUT, emit)).plan).toBeUndefined()
    expect(client.calls).toBeLessThanOrEqual(ARCHITECT_LIMITS.maxTurns)
    expect(events.map((event) => event.type)).toEqual([
      'agent:start',
      ...Array.from({ length: ARCHITECT_LIMITS.maxTurns }, () => [
        'tool:call',
        'tool:result',
      ]).flat(),
      'refused',
    ])
    expect(events.at(0)).toEqual({ type: 'agent:start', agent: 'architect' })
    expect(events.at(-1)).toEqual({
      type: 'refused',
      agent: 'architect',
      reason: expect.any(String),
    })
  })

  it('gives up early when the reads keep returning nothing', async () => {
    const client = scripted(
      Array.from({ length: 20 }, () => turnCalling('search_entities', { env: 'nowhere' })),
    )
    const { emit } = collect()
    await draftPlan(client, readTools(), INPUT, emit)
    expect(client.calls).toBeLessThanOrEqual(ARCHITECT_LIMITS.maxBarrenTurns + 1)
    expect(client.calls).toBeLessThan(ARCHITECT_LIMITS.maxTurns)
  })

  it('caps the calls it executes in one turn and says the rest were not run', async () => {
    const many = Array.from({ length: 9 }, () =>
      toolCall('search_entities', { type: 'database', env: 'prod' }),
    )
    const client = capturing([
      { text: '', toolCalls: many, finishReason: 'tool-calls' },
      proposing([ACCESS]),
    ])
    const { events, emit } = collect()
    await draftPlan(client, readTools(), INPUT, emit)
    expect(events.filter((event) => event.type === 'tool:call')).toHaveLength(
      ARCHITECT_LIMITS.maxCallsPerTurn,
    )
    expect(JSON.stringify(client.seen.at(-1)?.transcript)).toContain('not executed')
  })

  it('reports the proposal as a plan, never as one more tool call', async () => {
    // The proposal is the terminal channel: it ends the draft or is refused,
    // and it is never one more read in the stream. So no tool:call and no
    // tool:result for it — and a plan:ready that carries a COUNT, not the plan.
    // A plan reaches a reviewer as a diff and the engine as a signed object;
    // an event carrying the plan would be a third way for it to travel.
    const client = scripted([
      turnCalling('search_entities', { type: 'database', env: 'prod' }),
      proposing([ACCESS]),
    ])
    const { events, emit } = collect()
    await draftPlan(client, readTools(), INPUT, emit)

    expect(events.map((event) => event.type)).toEqual([
      'agent:start',
      'tool:call',
      'tool:result',
      'plan:ready',
    ])
    const ready = events.find((event) => event.type === 'plan:ready')
    expect(ready).toEqual({ type: 'plan:ready', operations: 1 })
    expect(JSON.stringify(events)).not.toContain('database-access')
  })

  it('degrades to an open tool choice when the provider rejects a forced one', async () => {
    // Forcing a tool is model-dependent: some reject it with a 400, and the SDK
    // throws when a forced call does not come back. Neither may take the draft
    // down with it.
    const seen: unknown[] = []
    let calls = 0
    const client: LlmClient = {
      generate: async (request) => {
        seen.push(request.toolChoice)
        calls += 1
        if (typeof request.toolChoice === 'object') {
          throw new Error("Model response did not contain a call to the required tool 'propose'.")
        }
        return calls > 3
          ? proposing([ACCESS])
          : turnCalling('search_entities', { type: 'database', env: 'prod' })
      },
    }
    const { emit } = collect()
    // Productive reads, so the barren bound does not end the loop first: this
    // case is about the forced tool choice and nothing else.
    const plan = (await draftPlan(client, readTools(), INPUT, emit)).plan
    expect(seen).toContain('auto')
    expect(plan?.operations).toEqual([ACCESS])
  })

  it('does not swallow a failure that has nothing to do with the tool choice', async () => {
    const client: LlmClient = {
      generate: async () => {
        throw new Error('the provider is down')
      },
    }
    const { emit } = collect()
    await expect(draftPlan(client, readTools(), INPUT, emit)).rejects.toThrow(/provider is down/)
  })

  it('refuses when the model stops without proposing anything', async () => {
    const client = scripted([{ text: 'looks fine to me', toolCalls: [], finishReason: 'stop' }])
    const { events, emit } = collect()
    expect((await draftPlan(client, readTools(), INPUT, emit)).plan).toBeUndefined()
    expect(events.some((event) => event.type === 'refused')).toBe(true)
  })
})

describe('the repair loop, where it was dead', () => {
  it('grants a turn back when the proposal is refused on the FORCED turn', async () => {
    // The case the whole repair loop exists for, and the one it could not
    // reach: a terminal call rejected on the last allowed turn wrote its error
    // into a transcript that was never sent again. The model was told exactly
    // what was wrong with its proposal and never got to act on it.
    const bad = { op: 'create-entity', entity: { kind: 'Resource', metadata: {} } }
    const turns = [
      turnCalling('search_entities', { type: 'database', env: 'prod' }),
      turnCalling('search_entities', { type: 'database', env: 'prod' }),
      turnCalling('search_entities', { type: 'database', env: 'prod' }),
      // the forced turn, refused
      turnCalling(PROPOSE_TOOL, { operations: [bad] }),
      // the turn that only exists because one was granted back
      proposing([ACCESS]),
    ]
    const client = scripted(turns)
    const { events, emit } = collect()

    const outcome = await draftPlan(client, readTools(), INPUT, emit)

    expect(outcome.plan).toBeDefined()
    expect(outcome.rejections).toBe(1)
    expect(events.filter((event) => event.type === 'retry')).toHaveLength(1)
  })

  it('stops granting them, so a model that never gets it right still ends', async () => {
    const bad = { op: 'create-entity', entity: { kind: 'Resource', metadata: {} } }
    const client = scripted(
      Array.from({ length: 20 }, () => turnCalling(PROPOSE_TOOL, { operations: [bad] })),
    )
    const { emit } = collect()

    const outcome = await draftPlan(client, readTools(), INPUT, emit)

    expect(outcome.plan).toBeUndefined()
    // maxTurns plus the repairs, and not one turn more.
    expect(client.calls).toBeLessThanOrEqual(ARCHITECT_LIMITS.maxTurns + MAX_REPAIRS + 1)
  })
})

describe('an agent is not handed another agent’s terminal channel', () => {
  it('does not offer `answer`, and refuses it if asked for anyway', async () => {
    // `buildTools` — the only bag this codebase builds — carries `answer`, and
    // it returns `{result: call.args}`. Forwarded unfiltered, that is a tool
    // that echoes the model's own invented references back as something the
    // engine said: the one shape the propose tool exists to prevent. Every
    // test here filtered it out by hand, so the shipped combination was the
    // one never exercised.
    const client = capturing([
      turnCalling('answer', { outcome: 'entities', refs: ['resource:default/invented'] }),
      proposing([ACCESS]),
    ])
    const bag = readTools()
    const withAnswer = {
      ...bag,
      specs: [
        ...bag.specs,
        { name: 'answer', description: 'x', parameters: buildProposeTool().spec.parameters },
      ],
      run: () => ({ result: { echoed: 'resource:default/invented' }, rows: 1, truncated: 0 }),
    }
    const { emit } = collect()

    await draftPlan(client, withAnswer, INPUT, emit)

    // Never offered...
    for (const request of client.seen) {
      expect(request.tools.map((tool) => tool.name)).not.toContain('answer')
    }
    // ...and never executed, because listing is not the enforcement. The echo
    // the model asked for must not come back as a tool RESULT.
    expect(JSON.stringify(client.seen)).not.toContain('echoed')
  })
})

describe('the escape hatch is not a channel', () => {
  it('bounds the reason an {unknown} carries', async () => {
    // Every stated value in a proposal is length-capped. Leaving the reason
    // uncapped made `{unknown}` the one field with no ceiling — an unbounded
    // run of arbitrary text travelling verbatim through the engine and into
    // the next agent's opening message. "I do not know" is not a payload slot.
    const huge = 'A'.repeat(20_000)
    const client = scripted([
      turnCalling(PROPOSE_TOOL, {
        operations: [
          {
            op: 'create-entity',
            entity: {
              kind: 'Resource',
              metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
              spec: { type: 'database-access', access: 'read', owner: { unknown: huge } },
            },
          },
        ],
      }),
      proposing([ACCESS]),
    ])
    const { emit } = collect()

    const outcome = await draftPlan(client, readTools(), INPUT, emit)

    expect(JSON.stringify(outcome.plan ?? {})).not.toContain('AAAAAAAAAA'.repeat(100))
  })

  it('the propose tool witnesses nothing, so it cannot vouch for a fabrication', () => {
    const propose = buildProposeTool()
    propose.run(toolCall(PROPOSE_TOOL, { operations: [ACCESS] }))

    expect([...propose.witnessed]).toEqual([])
  })
})

describe('a run that stops is a run that says it stopped', () => {
  it('closes the event stream before letting a provider failure through', async () => {
    // Two things at once, and they are not in tension. The error is NOT
    // swallowed: a caller that asked for a plan is owed the difference between
    // "no proposal was made" and "I could not reach the model". But
    // `agent:start` is already on the sink, and letting the rejection through
    // untouched left a stream showing an agent that began and never ended.
    const exploding: LlmClient = {
      generate: () => Promise.reject(new Error('502 from the gateway')),
    }
    const { events, emit } = collect()

    await expect(draftPlan(exploding, readTools(), INPUT, emit)).rejects.toThrow('502')

    expect(events.map((event) => event.type)).toEqual(['agent:start', 'refused'])
    const refusal = events.find((event) => event.type === 'refused')
    expect(refusal && 'reason' in refusal ? refusal.reason : '').toContain('502')
  })
})
