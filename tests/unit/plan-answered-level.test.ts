import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, promptOnTerminal } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { ASK_LIMITS, questionLines, runIntent, type Ask } from '../../src/cli/commands/plan.js'
import type { Question } from '../../src/core/plan/clarify.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import { hashTree } from '../support/tree.js'

/**
 * The owner's run, from inside their declarations repository, with no
 * application repository to inspect:
 *
 *     idpa "donne à component:default/billing-api un accès en lecture à
 *           resource:default/orders-db-prod en prod"
 *
 * The draft joined billing-api to orders-api's grant, which declares
 * readwrite. "lecture" is French and the engine does not translate, so the
 * level was asked; the person typed `read`, guessing the words it would take.
 * The policy refused — rightly: appending cannot narrow a grant — and handed
 * the Architect a remedy whose first option was readwrite, while the engine put
 * `read` back into every redraft. Three attempts, one refusal, three times.
 * The safety held; the loop could not converge.
 *
 * What a run like it must do now: tell the Architect the level is the user's,
 * offer only the grant of its own, carry the answer to that grant without
 * asking again, and — when it still cannot pass — say whose value it was and
 * what would.
 */

const REQUEST =
  'donne à component:default/billing-api un accès en lecture à resource:default/orders-db-prod en prod'

const BILLING = 'component:default/billing-api'
const DATABASE = 'resource:default/orders-db-prod'
const ORDERS_GRANT = 'resource:default/orders-api-orders-db-prod'
const NEW_GRANT_FILE = 'dependencies/access/billing-api-orders-db-prod.yml'
const JOINED_AT = 'operations.0.patch.access'
const DECLARED_AT = 'operations.0.entity.spec.access'
const THE_ACCESS = `${BILLING}'s access to ${DATABASE}`

/** The engine's own question when it cannot vouch for the draft's level. */
const SIGNER_ASKS = 'nothing vouches for this access; which one is it?'

/** The demo SI's shape: components in their folder, orders-api holding a readwrite grant. */
const FILES: Record<string, string> = {
  'components/.witness.yml': '---\n',
  'components/billing-api.yml': [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    '  name: billing-api',
    'spec:',
    '  type: service',
    '  lifecycle: production',
    '  owner: group:default/tiger',
    '',
  ].join('\n'),
  'components/orders-api.yml': [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    '  name: orders-api',
    'spec:',
    '  type: service',
    '  lifecycle: production',
    '  owner: group:default/tiger',
    '',
  ].join('\n'),
  'catalog/databases/orders-db-prod.yml': [
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
  ].join('\n'),
  'dependencies/access/orders-api-orders-db-prod.yml': [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: orders-api-orders-db-prod',
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: database-access',
    '  access: readwrite',
    '  owner: group:default/tiger',
    '  dependsOn:',
    '    - resource:default/orders-db-prod',
    '  dependencyOf:',
    '    - component:default/orders-api',
    '',
  ].join('\n'),
}

/** The demo SI's shape, with `extra` added to it or written over it. */
const repository = async (extra: Record<string, string> = {}): Promise<string> => {
  const repo = path.join(await mkdtemp(path.join(tmpdir(), 'idp-level-')), 'iac')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  for (const [relative, text] of Object.entries({ ...FILES, ...extra })) {
    const absolute = path.join(repo, ...relative.split('/'))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, text, 'utf8')
  }
  return repo
}

/** Replays scripted turns keyed by agent, and keeps every request it was sent. */
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

/** The Architect reads the grant it is about to extend, then proposes. */
const readingTheGrant = turnCalling('get_entity', { ref: ORDERS_GRANT })

const proposing = (...operations: unknown[]): GenerateResult =>
  turnCalling(PROPOSE_TOOL, { operations })

/** Joining billing-api to orders-api's grant, as the owner's draft did. */
const joining = (access?: unknown) => ({
  op: 'update-entity',
  entityRef: ORDERS_GRANT,
  patch: {
    patch: 'add-dependency-of',
    consumer: BILLING,
    ...(access === undefined ? {} : { access }),
  },
})

/** A grant of billing-api's own, which is what honours the answer. */
const ownGrant = (access: unknown) => ({
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access',
      access,
      owner: { unknown: 'the request does not name an owner' },
      dependsOn: [DATABASE],
      dependencyOf: [BILLING],
    },
  },
})

const approving = { reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })] }

/** Answers every level with `level`, declines everything else, and keeps what it was shown. */
const answeringLevel = (level: string): { ask: Ask; asked: Question[] } => {
  const asked: Question[] = []
  return {
    asked,
    ask: async (question) => {
      asked.push(question)
      return question.path.endsWith('.access') ? level : undefined
    },
  }
}

const collect = (): { events: AgentEvent[]; emit: (event: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (event) => void events.push(event) }
}

/** The opening message of each Architect draft, in the order they were sent. */
const architectOpenings = (client: { seen: GenerateRequest[] }): string[] =>
  client.seen
    .filter((request) => request.agent === 'architect')
    .map((request) => {
      const first = request.transcript[0]
      return first !== undefined && first.role === 'user' ? first.text : ''
    })
    .filter((text, index, all) => all.indexOf(text) === index)

/** What the Architect is handed after the filled plan is refused: the bytes, whole. */
const USERS_REPORT = [
  'the plan was refused at the policy gate:',
  '',
  `  declared-level-mismatch at ${JOINED_AT}: ${ORDERS_GRANT} grants readwrite, and this ` +
    'plan grants read. The user asked for read. A level is a scalar and this tool only ever ' +
    'appends (§4.3), so appending cannot change the level a grant declares: declare a separate ' +
    `grant for ${BILLING} over ${DATABASE} that states access read, instead of adding it to ` +
    'this one.',
  '',
  'Each line names a field by its path in the plan you proposed. Propose again with those ' +
    'fixed, and {"unknown": "<why>"} wherever you cannot determine a value.',
  '',
  "These values are the user's, and are put back into every draft whatever you write:",
  '',
  `  ${JOINED_AT} = read (${THE_ACCESS})`,
  '',
  'Choose operations that honour them.',
].join('\n')

const runOwners = async (
  architect: GenerateResult[],
  ask: Ask | undefined,
  options: {
    json?: boolean
    request?: string
    files?: Record<string, string>
    reviewer?: GenerateResult[]
  } = {},
) => {
  const repo = await repository(options.files)
  const before = await hashTree(repo)
  const client = scripted({ architect, reviewer: options.reviewer ?? approving.reviewer })
  const { events, emit } = collect()
  const result = await runIntent({
    intent: options.request ?? REQUEST,
    repo,
    project: undefined,
    client,
    emit,
    ...(ask === undefined ? {} : { ask }),
    ...(options.json === true ? { json: true } : {}),
  })
  expect(await hashTree(repo)).toBe(before)
  return { result, client, events }
}

describe("the owner's run: a level the person answered", () => {
  it('(a) tells the Architect the level is theirs, and offers only a grant of its own', async () => {
    const { ask } = answeringLevel('read')

    const { client, events } = await runOwners(
      [readingTheGrant, proposing(joining('readwrite')), proposing(joining('readwrite'))],
      ask,
    )

    // The first opening carries no report; the second is the refusal of the
    // plan the person filled, and it is the report above to the byte.
    const openings = architectOpenings(client)
    expect(openings).toHaveLength(2)
    expect(openings[0]).not.toContain('the plan was refused')
    expect(openings[1]?.endsWith(`\n${USERS_REPORT}`)).toBe(true)
    expect(openings[1]).not.toContain(`State '"access": "readwrite"'`)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'repair', attempt: 1, gate: 'policy' }),
    )
  })

  it('(b) carries the answer to the grant the Architect declares, and ends on the diff', async () => {
    const { ask, asked } = answeringLevel('read')

    const { result, events } = await runOwners(
      [
        readingTheGrant,
        proposing(joining('readwrite')),
        proposing(ownGrant({ unknown: 'which level does billing-api need?' })),
      ],
      ask,
    )

    expect(asked.map((question) => question.path)).toEqual([JOINED_AT])
    expect(result.found).toBe(true)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain(`+++ b/${NEW_GRANT_FILE}`)
    expect(result.text).toContain('+  access: read')
    expect(result.text).not.toContain('+  access: readwrite')
    expect(events).toContainEqual({
      type: 'reapplied',
      path: DECLARED_AT,
      value: 'read',
      entity: THE_ACCESS,
      answeredAt: JOINED_AT,
    })
  })

  it('(b) says nothing when the redraft already states the level the person gave', async () => {
    const { ask, asked } = answeringLevel('read')

    const { result, events } = await runOwners(
      [readingTheGrant, proposing(joining('readwrite')), proposing(ownGrant('read'))],
      ask,
    )

    expect(asked).toHaveLength(1)
    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${NEW_GRANT_FILE}`)
    expect(events.filter((event) => event.type === 'reapplied')).toEqual([])
  })

  it('(c) asks the level of an English request too: a level is never read from words', async () => {
    // The signer's rule, kept: "read access" does not vouch for `read`
    // (`signPlan`: "do not grant readwrite, only read" once signed readwrite as
    // echoed). So the English request is asked exactly as the French one is,
    // and converges the same way once answered.
    const { ask, asked } = answeringLevel('read')

    const { result, client } = await runOwners(
      [
        readingTheGrant,
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
        proposing(ownGrant('read')),
      ],
      ask,
      { request: `give ${BILLING} read access to ${DATABASE} in prod` },
    )

    expect(asked.map((question) => question.path)).toEqual([JOINED_AT])
    // The same report as the French request's, to the byte: the separate
    // grant is the only remedy, and the level is said to be the user's.
    expect(architectOpenings(client)[1]?.endsWith(`\n${USERS_REPORT}`)).toBe(true)
    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${NEW_GRANT_FILE}`)
  })

  it('(5) stops after three attempts naming the value as theirs, and what would pass', async () => {
    const { ask } = answeringLevel('read')

    const { result } = await runOwners(
      [
        readingTheGrant,
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
      ],
      ask,
    )

    expect(result.found).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('refused at the policy gate: 3 attempts')
    expect(result.text).not.toContain('Name the value the gate could not accept')
    expect(result.text.trimEnd().split('\n').slice(-5)).toEqual([
      'Nothing was previewed, and nothing was written. The gate refused a value you gave, and it ' +
        'was kept rather than changed:',
      '',
      `  ${JOINED_AT} = read — what would pass is a separate grant at read for ${BILLING} over ` +
        `${DATABASE}`,
      '',
      'Run this again asking for it.',
    ])
  })
})

describe("a level the person did not set keeps today's words", () => {
  it('(d) an omitted level: the message and the report are the bytes main sends', async () => {
    const { client } = await runOwners(
      [readingTheGrant, proposing(joining(undefined)), proposing(joining(undefined))],
      undefined,
    )

    const report = [
      'the plan was refused at the policy gate:',
      '',
      `  declared-level-mismatch at ${JOINED_AT}: ${ORDERS_GRANT} grants readwrite, and this ` +
        'plan states no level. A level is a scalar and this tool only ever appends (§4.3), so ' +
        `what would be granted is the level the repository declares. State '"access": ` +
        `"readwrite"' to hand over what it grants, or declare a separate grant for a different ` +
        'level.',
      '',
      'Each line names a field by its path in the plan you proposed. Propose again with those ' +
        'fixed, and {"unknown": "<why>"} wherever you cannot determine a value.',
    ].join('\n')
    const openings = architectOpenings(client)
    expect(openings[1]?.endsWith(`\n${report}`)).toBe(true)
  })

  it('(d) a refusal elsewhere after an answered round hands back no block', async () => {
    // The shape of the `link-db-missing` tape: the level answered, the filled
    // plan refused by the Reviewer. Nothing refused is the person's, and the
    // report stays the one that tape recorded.
    const { ask } = answeringLevel('read')
    const client = scripted({
      architect: [readingTheGrant, proposing(ownGrant('readwrite')), proposing(ownGrant('read'))],
      reviewer: [
        turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: 'not what was asked' }),
        turnCalling(VERDICT_TOOL, { verdict: 'ok' }),
      ],
    })
    const repo = await repository()

    await runIntent({
      intent: REQUEST,
      repo,
      project: undefined,
      client,
      emit: () => undefined,
      ask,
    })

    const openings = architectOpenings(client)
    expect(openings[1]).toContain('the plan was refused at the reviewer gate:')
    expect(openings[1]).not.toContain("These values are the user's")
  })
})

/** orders-api's network flow to the same database: a right, with no level. */
const NETWORK_GRANT = 'resource:default/orders-api-to-orders-db-prod'
const NETWORK_FILE = 'dependencies/network/orders-api-to-orders-db-prod.yml'
const WITH_NETWORK: Record<string, string> = {
  [NETWORK_FILE]: [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: orders-api-to-orders-db-prod',
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: network-access',
    '  owner: group:default/tiger',
    '  dependsOn:',
    '    - resource:default/orders-db-prod',
    '  dependencyOf:',
    '    - component:default/orders-api',
    '',
  ].join('\n'),
}

/** Read before it is joined: a reference is witnessed by what the tools returned. */
const readingTheNetwork = turnCalling('get_entity', { ref: NETWORK_GRANT })

const joiningNetwork = {
  op: 'update-entity',
  entityRef: NETWORK_GRANT,
  patch: { patch: 'add-dependency-of', consumer: BILLING },
}

const refusing = turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: 'not what was asked' })
const approvingOnce = turnCalling(VERDICT_TOOL, { verdict: 'ok' })
const WHICH_LEVEL = { unknown: 'which level does billing-api need?' }

describe('a level is carried only onto a grant that states one', () => {
  it('does not count a network flow over the database as the access stated twice', async () => {
    // Counted as one, the network join and the grant were the same access
    // stated twice, and the level the person gave was asked again.
    const { ask, asked } = answeringLevel('read')

    const { result, events } = await runOwners(
      // The filled plan is refused by the Reviewer, and the redraft states
      // the access and the network flow side by side.
      [
        readingTheGrant,
        proposing(ownGrant(WHICH_LEVEL)),
        readingTheNetwork,
        proposing(ownGrant(WHICH_LEVEL), joiningNetwork),
      ],
      ask,
      { files: WITH_NETWORK, reviewer: [refusing, approvingOnce] },
    )

    expect(asked.map((question) => question.path)).toEqual([DECLARED_AT])
    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${NEW_GRANT_FILE}`)
    expect(result.text).toContain(`+++ b/${NETWORK_FILE}`)
    expect(events.filter((event) => event.type === 'reapplied')).toEqual([
      expect.objectContaining({ path: DECLARED_AT, value: 'read', entity: THE_ACCESS }),
    ])
  })

  it('writes no level into a join to a network flow', async () => {
    // A level carried there is one the grant cannot state: the policy refused
    // a legitimate join over a value the engine had put in it.
    const { ask } = answeringLevel('read')

    const { result, events } = await runOwners(
      [
        readingTheGrant,
        proposing(ownGrant(WHICH_LEVEL)),
        readingTheNetwork,
        proposing(joiningNetwork),
      ],
      ask,
      { files: WITH_NETWORK, reviewer: [refusing, approvingOnce] },
    )

    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${NETWORK_FILE}`)
    expect(result.text).not.toContain('declared-level-mismatch')
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'reapplied', path: JOINED_AT }),
    )
  })
})

describe('a grant over two things', () => {
  const OVER_TWO: Record<string, string> = {
    'catalog/databases/orders-db-replica.yml': (FILES['catalog/databases/orders-db-prod.yml'] ?? '')
      .replace('orders-db-prod', 'orders-db-replica'),
    'dependencies/access/orders-api-orders-db-prod.yml': (
      FILES['dependencies/access/orders-api-orders-db-prod.yml'] ?? ''
    ).replace(
      '    - resource:default/orders-db-prod\n',
      '    - resource:default/orders-db-prod\n    - resource:default/orders-db-replica\n',
    ),
  }

  it('still offers a grant of its own for the consumer, and names no thing it cannot', async () => {
    const { ask } = answeringLevel('read')

    const { result, client } = await runOwners(
      [
        readingTheGrant,
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
      ],
      ask,
      { files: OVER_TWO },
    )

    expect(architectOpenings(client)[1]).toContain(
      `declare a separate grant for ${BILLING} that states access read, instead of adding it to ` +
        'this one.',
    )
    expect(result.found).toBe(false)
    // Never "a value the gate can accept": for a level, that is the grant's
    // own, and more than they asked for.
    expect(result.text.trimEnd().split('\n').slice(-3)).toEqual([
      `  ${JOINED_AT} = read — what would pass is a separate grant at read for ${BILLING}`,
      '',
      'Run this again asking for it.',
    ])
  })
})

describe("the values the report says are the user's", () => {
  /** A database of billing's own whose owner the draft left to the person. */
  const ledger = {
    op: 'create-entity',
    entity: {
      kind: 'Resource',
      metadata: { name: 'billing-ledger', env: 'prod' },
      spec: { type: 'database', owner: { unknown: 'who owns the ledger?' } },
    },
  }
  const TIGER = 'group:default/tiger'

  it('lists every value the engine puts back, the refused one and the rest', async () => {
    const asked: Question[] = []
    const ask: Ask = async (question) => {
      asked.push(question)
      if (question.path.endsWith('.access')) return 'read'
      if (question.path.endsWith('.name')) return 'billing-ledger'
      return question.path.endsWith('.owner') ? TIGER : undefined
    }

    const { client } = await runOwners(
      [
        readingTheGrant,
        proposing(joining('readwrite'), ledger),
        proposing(joining('readwrite'), ledger),
      ],
      ask,
    )

    expect(asked.map((question) => question.path)).toEqual([
      JOINED_AT,
      'operations.1.entity.metadata.name',
      'operations.1.entity.spec.owner',
    ])
    const opening = architectOpenings(client)[1] ?? ''
    expect(opening.endsWith(
      [
        "These values are the user's, and are put back into every draft whatever you write:",
        '',
        `  ${JOINED_AT} = read (${THE_ACCESS})`,
        '  operations.1.entity.metadata.name = billing-ledger (resource:default/billing-ledger)',
        `  operations.1.entity.spec.owner = ${TIGER} (resource:default/billing-ledger)`,
        '',
        'Choose operations that honour them.',
      ].join('\n'),
    )).toBe(true)
    // One finding, at the level: the owner is listed and was not refused.
    expect(opening.match(/declared-level-mismatch/g)).toHaveLength(1)
  })

  it('adds nothing when a policy refuses a value not theirs, in an answered round', async () => {
    // A consumer joined to the database itself, beside the grant that carries
    // the answer: the refusal is at operations.1, and nothing there is theirs.
    const { ask } = answeringLevel('read')
    const onTheDatabase = {
      op: 'update-entity',
      entityRef: DATABASE,
      patch: { patch: 'add-dependency-of', consumer: BILLING },
    }

    // The filled plan is refused by the Reviewer; the redraft, by the policy.
    const { client } = await runOwners(
      [
        readingTheGrant,
        proposing(ownGrant(WHICH_LEVEL)),
        proposing(ownGrant(WHICH_LEVEL), onTheDatabase),
        proposing(ownGrant(WHICH_LEVEL)),
      ],
      ask,
      { reviewer: [refusing, approvingOnce] },
    )

    const opening = architectOpenings(client)[2] ?? ''
    expect(opening).toContain('consumer-on-an-object at operations.1')
    expect(opening).not.toContain("These values are the user's")
    expect(opening.endsWith('wherever you cannot determine a value.')).toBe(true)
  })
})

describe('(e) the question says what it accepts', () => {
  it('shows the draft value and the accepted levels, where nobody is there to answer', async () => {
    const { result } = await runOwners(
      [readingTheGrant, proposing(joining('readwrite'))],
      undefined,
    )

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain(
      [
        `  ${JOINED_AT}`,
        `      ${SIGNER_ASKS}`,
        '      the draft says readwrite · accepted: read, readwrite',
      ].join('\n'),
    )
  })

  it('builds each question from the same lines, cleaned', () => {
    expect(
      questionLines({
        path: JOINED_AT,
        question: SIGNER_ASKS,
        proposed: 'readwrite',
        accepted: ['read', 'readwrite'],
      }),
    ).toEqual([
      `  ${JOINED_AT}`,
      `      ${SIGNER_ASKS}`,
      '      the draft says readwrite · accepted: read, readwrite',
    ])
    expect(
      questionLines({
        path: 'operations.0.entity.metadata.env',
        question: 'nothing vouches for this env; which one is it?',
        inUse: ['dev', 'prod'],
      }).at(-1),
    ).toBe('      in use: dev, prod')
    // A value the model wrote is cleaned like every other line it reaches.
    expect(
      questionLines({
        path: JOINED_AT,
        question: SIGNER_ASKS,
        proposed: 'read\u001b[2J\nwrite',
      }).at(-1),
    ).toBe('      the draft says read write')
  })

  it('writes those lines at the terminal prompt, and reads the answer after them', async () => {
    // What a person at a TTY sees, written by the prompt itself — not the
    // lines it is built from, which would pass with the prompt reverted.
    const question: Question = {
      path: JOINED_AT,
      question: SIGNER_ASKS,
      proposed: 'readwrite',
      accepted: ['read', 'readwrite'],
    }
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer) => void (written += chunk.toString('utf8')))

    const answered = promptOnTerminal(input, output)(question)
    input.write('read\n')

    expect(await answered).toBe('read')
    expect(written).toBe(
      [
        `  ${JOINED_AT}`,
        `      ${SIGNER_ASKS}`,
        '      the draft says readwrite · accepted: read, readwrite',
        '  > ',
      ].join('\n'),
    )
  })

  it('takes a closed input at the prompt as a decline', async () => {
    const input = new PassThrough()
    const answered = promptOnTerminal(input, new PassThrough())({
      path: JOINED_AT,
      question: SIGNER_ASKS,
    })
    input.end()

    expect(await answered).toBeUndefined()
  })

  /** Says each of `said` in turn to the level, and keeps every question it was put. */
  const saying = (...said: (string | undefined)[]): { ask: Ask; asked: Question[] } => {
    const asked: Question[] = []
    return {
      asked,
      ask: async (question) => {
        asked.push(question)
        return said.shift()
      },
    }
  }

  it('asks again, naming what it refused, and goes on with the value the set holds', async () => {
    // The owner guessed. A guess outside the set costs the person one more
    // line, not the run and the draft it paid for.
    const { ask, asked } = saying('lecture', 'read')

    const { result, events } = await runOwners(
      [readingTheGrant, proposing(joining('readwrite')), proposing(ownGrant('read'))],
      ask,
    )

    expect(asked).toEqual([
      expect.not.objectContaining({ refused: expect.anything() }),
      expect.objectContaining({ path: JOINED_AT, refused: 'lecture' }),
    ])
    expect(questionLines(asked[1] ?? { path: '', question: '' }).at(-1)).toBe(
      '      not accepted: lecture',
    )
    // The one question event: asking again is the prompt's, not a new round.
    expect(events.filter((event) => event.type === 'ask')).toHaveLength(1)
    expect(result.found).toBe(true)
  })

  it('keeps an empty line after a refused value a decline', async () => {
    const { ask } = saying('lecture', '')

    const { result } = await runOwners([readingTheGrant, proposing(joining('readwrite'))], ask)

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain('asked rather than guessed')
  })

  it('refuses a third answer outside the set, naming the set, before any gate', async () => {
    // Three values outside it and the run stops, as it did on the first:
    // a bound turns "it keeps asking" into an outcome.
    const { ask, asked } = saying('lecture', 'lire', 'r')

    const { result, client, events } = await runOwners(
      [readingTheGrant, proposing(joining('readwrite'))],
      ask,
    )

    expect(asked).toHaveLength(ASK_LIMITS.triesPerQuestion)
    expect(result.found).toBe(false)
    expect(result.text).toContain(
      `the answer was refused — ${JOINED_AT}: r is not one of the values this field ` +
        'accepts: read, readwrite',
    )
    // No gate saw it: the one draft, and no repair.
    expect(architectOpenings(client)).toHaveLength(1)
    expect(events.filter((event) => event.type === 'repair')).toEqual([])
  })
})

describe('(g) --json', () => {
  it('carries the new facts as optional fields of each question, and nothing else', async () => {
    const { result } = await runOwners(
      [readingTheGrant, proposing(joining('readwrite'))],
      undefined,
      { json: true },
    )

    const report = JSON.parse(result.text) as Record<string, unknown>
    expect(Object.keys(report)).toEqual(['outcome', 'plan', 'questions'])
    expect(report['questions']).toEqual([
      {
        path: JOINED_AT,
        question: SIGNER_ASKS,
        proposed: 'readwrite',
        accepted: ['read', 'readwrite'],
      },
    ])
  })

  it('keeps the stopped report to its keys', async () => {
    const { ask } = answeringLevel('read')
    const { result } = await runOwners(
      [
        readingTheGrant,
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
      ],
      ask,
      { json: true },
    )

    expect(Object.keys(JSON.parse(result.text) as object)).toEqual([
      'outcome',
      'gate',
      'reason',
      'plan',
      'attempts',
    ])
  })
})

describe('through main', () => {
  it('exits 0 once the Architect declares the grant, and 1 when it never does', async () => {
    const run = async (architect: GenerateResult[]): Promise<number> => {
      const repo = await repository()
      const { ask } = answeringLevel('read')
      return main(['plan', REQUEST, '--repo', repo], {
        // Inside the declarations repository, as the owner was: no Inspector.
        cwd: repo,
        client: scripted({ architect, ...approving }),
        env: {},
        ask,
        out: () => undefined,
        err: () => undefined,
        events: () => undefined,
      })
    }

    expect(
      await run([readingTheGrant, proposing(joining('readwrite')), proposing(ownGrant('read'))]),
    ).toBe(0)
    expect(
      await run([
        readingTheGrant,
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
        proposing(joining('readwrite')),
      ]),
    ).toBe(1)
  })
})
