import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { main, renderEvent } from '../../src/cli/index.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'

/**
 * `ask` against a real model, on the owner's repository: one entity, Backstage's
 * own example `artist-web`, which declares no environment. The model fills
 * every optional field it is shown with an invented value, and the calls below
 * are the ones it sent, verbatim.
 *
 * Two runs failed on it. "Talk about this project" ended on `cannot answer:
 * nothing in the catalogue matched`, exit 3, after the model had answered
 * three times — an overview carrying the `refs` and `reason` the flat
 * advertisement offers it, refused each time. "what is artist-web?" ended on
 * `No entity matches`, exit 1, because an invented `env` excluded the one
 * entity there is and the tool said so with an empty result.
 */

/** The owner's document, as the repository holds it. */
const ARTIST_WEB = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: artist-web
  description: The place to be, for great artists
  labels:
    example.com/custom: custom_label_value
  annotations:
    example.com/service-discovery: artistweb
    circleci.com/project-slug: github/example-org/artist-website
  tags:
    - java
  links:
    - url: https://admin.example-org.com
      title: Admin Dashboard
      icon: dashboard
      type: admin-dashboard
spec:
  type: website
  lifecycle: production
  owner: artist-relations-team
  system: public-websites
`

const INVENTED_REF = 'component:default/site-placeholder'
const REASON = 'No entity matching artist-web was found.'

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push(request)
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

let ids = 0
const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${String((ids += 1))}`, name, args }],
  finishReason: 'tool-calls',
})

const QUESTION: GenerateResult[] = [{ text: 'QUESTION', toolCalls: [], finishReason: 'stop' }]

/** What gpt-6-luna sent for "Talk about this project", each of three turns. */
const OVERVIEW_WITH_EXTRAS = [
  { outcome: 'overview', refs: [INVENTED_REF], reason: ' ' },
  { outcome: 'overview', refs: [INVENTED_REF], reason: ' ' },
  { outcome: 'overview', refs: [INVENTED_REF], reason: ' ' },
]

/** What it sent for "what is artist-web?". */
const SEARCH_WITH_ENV = {
  kind: 'Component',
  type: 'website',
  env: 'default',
  owner: 'group:default/artist-relations-team',
  nameContains: 'artist-web',
}
const { env: _env, ...SEARCH_WITHOUT_ENV } = SEARCH_WITH_ENV

const repository = async (): Promise<string> => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ask-real-model-'))
  await mkdir(path.join(cwd, 'iac'))
  await writeFile(path.join(cwd, 'iac', 'catalog-info.yaml'), ARTIST_WEB, 'utf8')
  return cwd
}

const ask = async (
  question: string,
  analyst: GenerateResult[],
  { hooked = true }: { hooked?: boolean } = {},
) => {
  const cwd = await repository()
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const client = scripted({ supervisor: QUESTION, analyst })
  const code = await main(['ask', '--repo', 'iac', question], {
    cwd,
    client,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    // Unhooked, `main` draws the stream itself: what the terminal really shows.
    ...(hooked
      ? {
          events: (event: AgentEvent) => {
            events.push(event)
            // What the terminal shows, through the same renderer `main` uses.
            const line = renderEvent(event)
            if (line !== undefined) err.push(`${line}\n`)
          },
        }
      : {}),
  })
  return { code, out: out.join(''), err: err.join(''), events, client }
}

describe('"Talk about this project", with a model that fills every field', () => {
  it('takes the first overview and prints the one the engine wrote, exit 0', async () => {
    const { code, out, client } = await ask(
      'Talk about this project',
      OVERVIEW_WITH_EXTRAS.map((args) => calling('answer', args)),
    )

    expect(code).toBe(0)
    expect(out).toMatch(/^Overview of the repository iac: 1 entity/)
    expect(out).toMatch(/^\s+Component\s+1$/m)
    expect(out).toMatch(/^\s+website\s+1$/m)
    expect(out).toContain('group:default/artist-relations-team')
    // Accepted the first time: nothing handed back, nothing asked again.
    expect(client.seen.filter((request) => request.agent === 'analyst')).toHaveLength(1)
  })

  it('never lets the fields it discarded reach stdout, stderr or the event', async () => {
    const { out, err, events } = await ask(
      'Talk about this project',
      OVERVIEW_WITH_EXTRAS.map((args) => calling('answer', args)),
    )

    for (const text of [out, err, JSON.stringify(events)]) {
      expect(text).not.toContain('site-placeholder')
      expect(text).not.toContain('reason')
    }
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'overview', refs: [] })
  })
})

describe('"what is artist-web?", with a model that invents an environment', () => {
  it('tells the model the environment matches nothing, and answers once it drops it', async () => {
    const { code, out, err, client } = await ask('what is artist-web?', [
      calling('search_entities', SEARCH_WITH_ENV),
      calling('search_entities', SEARCH_WITHOUT_ENV),
      calling('answer', { outcome: 'entities', refs: ['component:default/artist-web'] }),
    ])

    // The first tool result the model was handed: an error it can act on, not
    // an empty list. (The transcript is one array, sent again each turn.)
    const [request] = client.seen.filter((each) => each.agent === 'analyst')
    const told = request?.transcript.find((message) => message.role === 'tool')
    expect(told).toMatchObject({ name: 'search_entities' })
    const error = (told as { result: { error?: string } } | undefined)?.result.error
    expect(error).toMatch(/env "default" matches no entity/)
    expect(error).toMatch(/declares no environment/)
    expect(error).toMatch(/omit env/)

    expect(code).toBe(0)
    expect(out).toContain('artist-web')
    expect(out).toContain('group:default/artist-relations-team')
    // The terminal says why the first search came back empty-handed, and what
    // the second one read.
    expect(err).toMatch(/← refused: search_entities: env "default" matches no entity/)
    expect(err).toMatch(/← 1 row\(s\)/)
    expect(err).not.toMatch(/← 0 row\(s\)/)
  })

  it('prints the refusal on the terminal through main\'s own progress stream', async () => {
    const { code, err } = await ask(
      'what is artist-web?',
      [
        calling('search_entities', SEARCH_WITH_ENV),
        calling('search_entities', SEARCH_WITHOUT_ENV),
        calling('answer', { outcome: 'entities', refs: ['component:default/artist-web'] }),
      ],
      { hooked: false },
    )

    expect(code).toBe(0)
    expect(err).toContain(
      '  ← refused: search_entities: env "default" matches no entity: ' +
        'this catalogue declares no environment — omit env',
    )
    expect(err).toContain('  ← 1 row(s)')
    expect(err).not.toContain('← 0 row(s)')
  })

  it('still ends on an honest "nothing" when the model ignores the hint', async () => {
    // Nothing was read, so a "nothing" contradicts nothing. The invented ref and
    // the reason it rides with are discarded like the overview's.
    const { code, out, err, events } = await ask('what is artist-web?', [
      calling('search_entities', SEARCH_WITH_ENV),
      calling('answer', { outcome: 'nothing', refs: ['component:default/artist-web'], reason: REASON }),
    ])

    expect(code).toBe(1)
    expect(out).toBe('No entity matches that question.\n')
    expect(err).toMatch(/← refused: /)
    expect(err).not.toContain(REASON)
    expect(events).toContainEqual({ type: 'answer:ready', outcome: 'nothing', refs: [] })
  })
})

describe('an answer that never fits', () => {
  it('says the answer was refused, and why, rather than that nothing matched', async () => {
    // The model answered three times; "nothing in the catalogue matched" was
    // false. An entities answer with no refs is refused by the union whatever
    // the flat advertisement allowed.
    const { code, err } = await ask(
      'what is artist-web?',
      Array.from({ length: 3 }, () => calling('answer', { outcome: 'entities' })),
    )

    expect(code).toBe(3)
    expect(err).toMatch(
      /cannot answer: the model answered 3 times and no answer fitted the answer tool; the last: refs: .*expected array/,
    )
    expect(err).not.toMatch(/nothing in the catalogue matched/)
  })

  it('still refuses an entities answer naming a reference no tool returned', async () => {
    const { code, err, out } = await ask('what is artist-web?', [
      calling('answer', { outcome: 'entities', refs: [INVENTED_REF], reason: REASON }),
    ])

    expect(code).toBe(3)
    expect(out).toBe('')
    expect(err).toMatch(/cannot answer: the answer named component:default\/site-placeholder/)
    expect(err).not.toContain(REASON)
  })
})

describe('a refused read, on the terminal', () => {
  it('prints the reason rather than an empty result', () => {
    // A call refused for its arguments counts no rows, and "← 0 row(s)" read
    // as a search that ran and found nothing.
    expect(
      renderEvent({
        type: 'tool:result',
        id: 'c1',
        name: 'search_entities',
        rows: 0,
        truncated: 0,
        error: 'search_entities: env "default" matches no entity',
      }),
    ).toBe('  ← refused: search_entities: env "default" matches no entity')
  })

  it('keeps it to one plain, bounded line: the value in it is the model\'s', () => {
    const line = renderEvent({
      type: 'tool:result',
      id: 'c1',
      name: 'search_entities',
      rows: 0,
      truncated: 0,
      error: `env "\u001B[2Jx\nsecond line" ${'y'.repeat(400)}`,
    })
    expect(line).not.toContain('\u001B')
    expect(line).not.toContain('\n')
    expect(line?.startsWith('  ← refused: env "x second line" ')).toBe(true)
    expect(line?.length).toBeLessThan(230)
    expect(line?.endsWith('…')).toBe(true)
  })

  it('still prints the row count for a read that answered, empty or not', () => {
    expect(renderEvent({ type: 'tool:result', id: 'c1', name: 'search_entities', rows: 0, truncated: 0 })).toBe(
      '  ← 0 row(s)',
    )
  })
})
