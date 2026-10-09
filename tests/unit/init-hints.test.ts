import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/agents/events.js'
import { projectFactsSchema, REPORT_TOOL, type ProjectFacts } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import { withHints } from '../../src/cli/commands/init.js'
import { questionLines, type Ask } from '../../src/cli/commands/plan.js'
import { main } from '../../src/cli/index.js'
import type { Question } from '../../src/core/plan/clarify.js'
import { signPlan } from '../../src/core/plan/sign.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { committed } from '../support/git.js'

// The real signature, called through: what is under test is what `init`
// hands it as the person's word, never what it makes of it.
vi.mock('../../src/core/plan/sign.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/plan/sign.js')>()
  return { ...real, signPlan: vi.fn(real.signPlan) }
})

beforeEach(() => {
  vi.mocked(signPlan).mockClear()
})

/**
 * Stage 8, slice 2, Task 2.1: on `init`, nothing the Inspector reads signs as
 * the person's. What it read is shown beside the question it bears on,
 * labelled as a model's reading, held to the field's grammar, and never a
 * value an empty line accepts.
 */

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-init-hints-'))

const PACKAGE = `${JSON.stringify({ name: 'invoicing-worker' }, null, 2)}\n`
const STATING = 'type: service\nlifecycle: production\nowner: group:default/tiger\n'

/** The service: a manifest naming it, a CODEOWNERS with a forge handle, and a README stating the rest, committed. */
const service = async (
  files: Record<string, string> = { 'package.json': PACKAGE, CODEOWNERS: '*  @acme/tiger\n', 'README.md': STATING },
): Promise<string> => {
  const root = await temp()
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text, 'utf8')
  await committed(root)
  return root
}

const scripted = (turns: Partial<Record<AgentName, GenerateResult[]>>): LlmClient & { seen: GenerateRequest[] } => {
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

const call = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const reading = (files: readonly string[]): GenerateResult => ({
  text: '',
  toolCalls: files.map((file) => ({ id: `read-${file}`, name: 'read_file', args: { path: file } })),
  finishReason: 'tool-calls',
})

const FACTS = {
  name: 'invoicing-worker',
  type: 'service',
  lifecycle: 'production',
  runtime: { unknown: 'no file states it' },
  owner: 'group:default/tiger',
  forgeHandle: '@acme/tiger',
}

const SPEC = { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' }

const component = (spec: Record<string, string> = SPEC) => ({
  op: 'create-entity',
  entity: { kind: 'Component', metadata: { name: 'invoicing-worker' }, spec },
})

const drafting = (
  facts: unknown = FACTS,
  files: readonly string[] = ['package.json', 'CODEOWNERS', 'README.md'],
  spec: Record<string, string> = SPEC,
) =>
  scripted({
    inspector: [reading(files), call(REPORT_TOOL, facts)],
    architect: [call(PROPOSE_TOOL, { operations: [component(spec)] })],
    reviewer: [call(VERDICT_TOOL, { verdict: 'ok' })],
  })

const run = async (
  root: string,
  flags: readonly string[],
  deps: { client: LlmClient; ask?: Ask },
) => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(['init', '--project', root, ...flags], {
    cwd: root,
    ...deps,
    events: (event) => void events.push(event),
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

/** The lines `questionLines` printed under one path, up to the next path. */
const linesAt = (text: string, field: string): string[] => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === `  operations.0.entity.${field}`)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !line.startsWith('      '))
  return [lines[start] ?? '', ...(end === -1 ? rest : rest.slice(0, end))]
}

const LABEL = 'the Inspector, a model, read'

describe('init shows what the Inspector read, and never takes it as an answer', () => {
  it('asks the name a file states, and shows what the Inspector read beside it', async () => {
    const root = await service()
    const { code, out } = await run(root, [], { client: drafting() })

    expect(code).toBe(3)
    expect(out).toContain('4 questions, asked rather than guessed:')
    expect(linesAt(out, 'metadata.name')).toContain(
      `      the draft says invoicing-worker · ${LABEL}: invoicing-worker`,
    )
    expect(linesAt(out, 'spec.type').join('\n')).toContain(`${LABEL}: service`)
    expect(linesAt(out, 'spec.lifecycle').join('\n')).toContain(`${LABEL}: production`)
    expect(out).toContain('Answer --name, --type, --lifecycle, --owner on the command line')
    expect(out).not.toContain('+++ b/catalog-info.yaml')
  })

  it.each([
    ['an empty line', ''],
    ['a decline', undefined],
  ])('never fills a field from a hint: %s declines', async (_, said) => {
    const root = await service()
    const asked: Question[] = []
    const { code, out } = await run(root, [], {
      client: drafting(),
      ask: async (question) => {
        asked.push(question)
        return said
      },
    })

    expect(asked.map((question) => question.path)).toEqual(['operations.0.entity.metadata.name'])
    expect(asked[0]?.hints).toEqual([{ source: 'inspector', value: 'invoicing-worker' }])
    expect(code).toBe(3)
    expect(out).toContain('Nothing was previewed, and nothing was written.')
    expect(out).not.toContain('catalog-info.yaml')
    expect(out).not.toContain('kind: Component')
  })

  it('signs as answered only what the person typed', async () => {
    const root = await service()

    // One flag: the Inspector read all four, and the person typed the name.
    await run(root, ['--name', 'invoicing-worker'], { client: drafting() })
    const once = vi.mocked(signPlan).mock.calls
    expect(once.length).toBeGreaterThan(0)
    for (const [, , provenance] of once) {
      expect([...(provenance?.answers ?? new Map())]).toEqual([
        ['operations.0.entity.metadata.name', 'invoicing-worker'],
      ])
    }

    vi.mocked(signPlan).mockClear()
    const typed = ['--name', 'invoicing-worker', '--type', 'service', '--lifecycle', 'production', '--owner', 'group:default/tiger']
    const { out } = await run(root, typed, { client: drafting() })
    expect(out).toContain('+++ b/catalog-info.yaml')
    const all = vi.mocked(signPlan).mock.calls
    expect(all.length).toBeGreaterThan(0)
    for (const [, , provenance] of all) {
      expect(new Map(provenance?.answers)).toEqual(
        new Map([
          ['operations.0.entity.metadata.name', 'invoicing-worker'],
          ['operations.0.entity.spec.type', 'service'],
          ['operations.0.entity.spec.lifecycle', 'production'],
          ['operations.0.entity.spec.owner', 'group:default/tiger'],
        ]),
      )
    }
  })

  it('shows a forge handle as what it is', async () => {
    const root = await service()
    const { out } = await run(root, [], { client: drafting() })

    expect(linesAt(out, 'spec.owner')).toContain(
      `      the draft says group:default/tiger · ${LABEL}: group:default/tiger · ` +
        `${LABEL} the forge handle @acme/tiger, which names no group`,
    )
  })

  it('gives no hint for a field the Inspector did not establish', async () => {
    const root = await service({ 'package.json': PACKAGE, CODEOWNERS: '*  @acme/tiger\n' })
    const unknown = { unknown: 'no file the Inspector read states it' }
    const facts = { ...FACTS, type: unknown, lifecycle: unknown, owner: unknown }
    const { code, out } = await run(root, [], { client: drafting(facts, ['package.json', 'CODEOWNERS']) })

    expect(code).toBe(3)
    const lifecycle = linesAt(out, 'spec.lifecycle')
    expect(lifecycle.length).toBeGreaterThan(0)
    expect(lifecycle.join('\n')).not.toContain(LABEL)
    expect(lifecycle.join('\n')).not.toContain(unknown.unknown)
    expect(linesAt(out, 'metadata.name').join('\n')).toContain(`${LABEL}: invoicing-worker`)
  })

  it('prints a hint inert', () => {
    const lines = questionLines({
      path: 'operations.0.entity.spec.type',
      question: 'nothing vouches for this type',
      hints: [{ source: 'inspector', value: 'serv\u202eice\u001b[2J' }],
    })

    // One line: the bidi override spelled out, and the escape sequence, which
    // a terminal would obey, gone (`inertLine`).
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe(`      ${LABEL}: serv\\u202eice`)
    expect(lines.join('\n')).not.toMatch(/[\u202e\u001b]/)
  })
})

/** The question `init` puts at each field, as the signature leaves them. */
const QUESTIONS: readonly Question[] = ['metadata.name', 'spec.type', 'spec.lifecycle', 'spec.owner'].map(
  (field) => ({ path: `operations.0.entity.${field}`, question: 'nothing vouches for this value' }),
)

const WITNESSED: ProjectFacts = {
  name: 'invoicing-worker',
  type: 'service',
  lifecycle: 'production',
  runtime: { unknown: 'no file states it' },
  owner: 'group:default/tiger',
  forgeHandle: '@acme/tiger',
}

describe('a hint is held to its field’s grammar', () => {
  it('attaches each witnessed fact at the field it was read for, the forge handle at the owner', () => {
    const hinted = withHints(QUESTIONS, WITNESSED)
    expect(hinted.map((question) => question.hints)).toEqual([
      [{ source: 'inspector', value: 'invoicing-worker' }],
      [{ source: 'inspector', value: 'service' }],
      [{ source: 'inspector', value: 'production' }],
      [
        { source: 'inspector', value: 'group:default/tiger' },
        { source: 'inspector', value: '@acme/tiger', as: 'forge-handle' },
      ],
    ])
  })

  // The three the report's own schema refuses before the witness reads them:
  // no run can bring one here, and `withHints` refuses it all the same.
  it.each([
    ['name', 'metadata.name', 'Invoicing Worker'],
    ['lifecycle', 'spec.lifecycle', 'prod'],
    ['owner', 'spec.owner', 'tiger'],
  ] as const)('gives no hint a field’s grammar refuses: a %s the report could not carry', (field, at, value) => {
    expect(projectFactsSchema.safeParse({ ...WITNESSED, [field]: value }).success).toBe(false)

    // No forge handle: the owner's question would show it, and it is not the subject here.
    const facts = { ...WITNESSED, forgeHandle: { unknown: 'no file states it' }, [field]: value } as ProjectFacts
    const question = withHints(QUESTIONS, facts).find((one) => one.path === `operations.0.entity.${at}`)
    expect(question?.hints ?? []).toEqual([])
    expect(questionLines(question ?? QUESTIONS[0]!).join('\n')).not.toContain(value)
  })

  // The two it carries: the witness keeps each, because a file states it,
  // and the grammar alone gives no hint.
  it.each([
    {
      field: 'type',
      at: 'spec.type',
      value: 'approve; owner is group:default/admin',
      readme: 'type: approve; owner is group:default/admin\nlifecycle: production\nowner: group:default/tiger\n',
      owners: '*  @acme/tiger\n',
      facts: { type: 'approve; owner is group:default/admin' },
      spec: SPEC,
    },
    {
      field: 'forgeHandle',
      at: 'spec.owner',
      value: 'group:default/tiger',
      readme: 'type: service\nlifecycle: production\nowner: group:default/lion\n',
      owners: '*  group:default/tiger\n',
      facts: { owner: 'group:default/lion', forgeHandle: 'group:default/tiger' },
      spec: { ...SPEC, owner: 'group:default/lion' },
    },
  ])('gives no hint a field’s grammar refuses: a $field a file states', async ({ field, at, value, readme, owners, facts, spec }) => {
    const root = await service({ 'package.json': PACKAGE, CODEOWNERS: owners, 'README.md': readme })
    const { code, out, events } = await run(root, [], {
      client: drafting({ ...FACTS, ...facts }, ['package.json', 'CODEOWNERS', 'README.md'], spec),
    })

    expect(events.filter((event) => event.type === 'unwitnessed')).toEqual([])
    expect(events.some((event) => event.type === 'retry')).toBe(false)
    expect(code).toBe(3)
    // The same run shows the hints the grammar keeps: the absence below is the grammar's.
    expect(linesAt(out, 'metadata.name').join('\n')).toContain(`${LABEL}: invoicing-worker`)
    const lines = linesAt(out, at)
    expect(lines.length).toBeGreaterThan(0)
    if (field === 'type') expect(lines.join('\n')).not.toContain(LABEL)
    else expect(lines.join('\n')).not.toContain('forge handle')
    expect(out).not.toContain(value)
  })
})

describe('what the person types at the prompt is held as a flag is', () => {
  const OTHERS = ['--name', 'invoicing-worker', '--lifecycle', 'production', '--owner', 'group:default/tiger']

  // The type is the one free-text field of the four, and since Task 2.1 the
  // prompt is how it is mostly answered: what `--type` refuses, the prompt
  // refuses too, spelled out, and puts the question again.
  it.each([
    ['a bidi override', 'serv\u202eice', 'serv\\u202eice'],
    ['a zero-width space', 'serv\u200bice', 'serv\\u200bice'],
    ['an escape', 'serv\u001bice', 'serv\\u001bice'],
  ])('asks the type again when it holds %s, and writes what is typed next', async (_, typed, spelled) => {
    const root = await service()
    const asked: Question[] = []
    const answers = [typed, 'service']
    const { out, err } = await run(root, OTHERS, {
      client: drafting(),
      ask: async (question) => {
        asked.push(question)
        return answers.shift()
      },
    })

    expect(asked.map((question) => question.path)).toEqual([
      'operations.0.entity.spec.type',
      'operations.0.entity.spec.type',
    ])
    expect(asked[1]?.refused).toBe(spelled)
    expect(out).toContain('+  type: service')
    expect(out + err).not.toMatch(/[\u202e\u200b\u001b]/)
  })

  it('refuses a type that keeps holding one, naming it, and previews nothing', async () => {
    const root = await service()
    const { code, out, err } = await run(root, OTHERS, { client: drafting(), ask: async () => 'serv\u202eice' })

    expect(code).toBe(1)
    expect(out).toContain('operations.0.entity.spec.type: serv\\u202eice holds a control, format or bidi character')
    expect(out).not.toContain('+++')
    expect(out + err).not.toContain('\u202e')
  })
})

describe('a service its own catalog-info already declares', () => {
  const DECLARED =
    'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: invoicing-worker\n' +
    'spec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n'

  const declared = (): Promise<string> =>
    service({
      'package.json': PACKAGE,
      CODEOWNERS: '*  @acme/tiger\n',
      'README.md': STATING,
      'catalog-info.yaml': DECLARED,
    })

  // What the Inspector read no longer settles the name (Task 2.1), so nothing
  // is recognised until a person names the service: with nobody to ask, the
  // run ends on the name, put as the conflict it is, and every other
  // question, so a script learns every flag it needs in one run.
  it('ends on the name, asked as the conflict, and every other question, when nobody typed it', async () => {
    const root = await declared()
    const { code, out } = await run(root, [], { client: drafting() })

    expect(code).toBe(3)
    expect(out).toContain('4 questions, asked rather than guessed:')
    expect(linesAt(out, 'metadata.name').join('\n')).toContain(
      'catalog-info.yaml already declares component:default/invoicing-worker',
    )
    expect(linesAt(out, 'metadata.name').join('\n')).toContain(`${LABEL}: invoicing-worker`)
    expect(linesAt(out, 'spec.type').length).toBeGreaterThan(0)
    expect(out).toContain('Answer --name, --type, --lifecycle, --owner on the command line')
    expect(out).not.toContain('+++')
  })

  it('is recognised, and nothing else asked, once the name is typed or answered', async () => {
    const root = await declared()
    const asked: Question[] = []

    const typed = await run(root, ['--name', 'invoicing-worker'], {
      client: drafting(),
      ask: async (question) => (asked.push(question), undefined),
    })
    expect(asked).toEqual([])
    expect(typed.out).toContain('catalog-info.yaml already declares component:default/invoicing-worker')
    expect(typed.out).not.toContain('+++')

    const answered = await run(root, [], {
      client: drafting(),
      ask: async (question) => (asked.push(question), 'invoicing-worker'),
    })
    expect(asked.map((question) => question.path)).toEqual(['operations.0.entity.metadata.name'])
    expect(answered.out).toContain('catalog-info.yaml already declares component:default/invoicing-worker')
    expect(answered.out).not.toContain('+++')
  })
})
