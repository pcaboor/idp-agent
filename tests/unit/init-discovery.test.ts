import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { initExit, runInitRepo, type InitEnding } from '../../src/cli/commands/init.js'
import { renderPreview } from '../../src/cli/commands/plan.js'
import type { SubmissionReport } from '../../src/cli/commands/submit.js'
import { coverageOf, type Coverage } from '../../src/core/discovery/report.js'
import { EXTRACTORS, findingsOf } from '../../src/core/discovery/extractors.js'
import { verifyFinding } from '../../src/core/discovery/verify.js'
import { blobId } from '../../src/core/git/blob.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { ENGINE_BLOCK_END } from '../../src/core/github/pull-request.js'
import type { AgentName, GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'
import { committed, git } from '../support/git.js'
import { removeClones } from '../support/forge-fixture.js'
import { githubClone } from '../support/github-fixture.js'
import { memorySink, onlyTrace } from '../support/trace.js'

/**
 * `idpa init` reports what the service's committed configuration states
 * (plan, Task 1.4): the report between the diff and how to apply it, its
 * sentence on stderr too, after the engine's block in the pull request, and
 * the exit the owner settled on 2026-10-04 — a preview, nothing to change or
 * a declined confirmation with no verified finding in a repository read in
 * part exits 1; a branch cut or a pull request opened exits 0.
 *
 * The repository is the owner's fixture (Task 1.2) merged with
 * `init-command.test.ts`'s `application()`: one `package.json` holding
 * `billing-api`'s name, which the scripted Inspector reads and witnesses, and
 * the fixture's three clients — four verified findings. `unverified` holds a
 * `pyproject.toml` in its place, which no slice-1 rule reads, so its only
 * findings are the sample's, which cannot vouch.
 *
 * NO REAL SECRET IS WRITTEN HERE: every password is a marked placeholder.
 */

const made: string[] = []
afterAll(async () => {
  await removeClones()
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const temp = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'idp-init-discovery-'))
  made.push(dir)
  return dir
}

const APPLY =
  "Nothing is written. To write it, save a run to a file, read it, and apply that file in the " +
  "service's repository — another run may draft other bytes than these: " +
  'idpa init > catalog-info.diff, then git apply catalog-info.diff'

const SAMPLE =
  'DATABASE_URL=mysql://app_billing:S4mple-Passw0rd-7Qz@localhost:3306/billing\n' +
  'REDIS_URL=redis://localhost:6379\n' +
  'PAYMENTS_URL=https://${PAYMENTS_HOST}/v1\n'
const PACKAGE = `${JSON.stringify(
  { name: 'billing-api', dependencies: { mysql2: '^3.9.0', ioredis: '^5.4.0', kafkajs: '^2.2.0' } },
  null,
  2,
)}\n`
const STATING = 'type: service\nlifecycle: production\nruntime: node\nowner: group:default/tiger\n'
const DECLARED =
  'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\nspec:\n' +
  '  type: service\n  lifecycle: production\n  owner: group:default/tiger\n'

/** The files of a service, its manifest npm's or Python's, not yet a repository. */
async function files(manifest: 'npm' | 'python', extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await temp()
  const all: Record<string, string> = {
    ...(manifest === 'npm'
      ? { 'package.json': PACKAGE }
      : { 'pyproject.toml': '[project]\nname = "billing-api"\n' }),
    CODEOWNERS: '* @acme/platform\n',
    'README.md': STATING,
    '.env.example': SAMPLE,
    'deploy/prod.env': 'DATABASE_URL=mysql://app_billing:Prod-Passw0rd-9Kx@billing-db.prod.internal:3306/billing\n',
    'src/index.ts': 'export const start = () => 0\n',
    '.gitignore': '.env\n',
    ...extra,
  }
  for (const [file, text] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text, 'utf8')
  }
  return root
}

/** A committed service, and the `.env` git ignores beside it. */
async function service(manifest: 'npm' | 'python', extra?: Readonly<Record<string, string>>): Promise<string> {
  const root = await files(manifest, extra)
  await committed(root)
  await writeFile(path.join(root, '.env'), 'DATABASE_URL=mysql://app_billing:Local-Passw0rd-3Mv@billing-db.prod.internal:3306/billing\n')
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

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [],
}

/**
 * What a person types for the four fields `FACTS` reads: since stage 8's
 * slice 2 (Task 2.1) what the Inspector reads is a hint beside a question and
 * never an answer, so a run that is about the report gives the flags it needs.
 */
const TYPED = { name: 'billing-api', type: 'service', lifecycle: 'production', owner: 'group:default/tiger' } as const

/** `TYPED`, as `init`'s flags. */
const TYPED_FLAGS = ['--name', TYPED.name, '--type', TYPED.type, '--lifecycle', TYPED.lifecycle, '--owner', TYPED.owner]

const COMPONENT = {
  op: 'create-entity',
  entity: {
    kind: 'Component',
    metadata: { name: 'billing-api' },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  },
}

/** The Inspector reads the manifest, CODEOWNERS and the README, and reports; the Architect proposes the Component. */
const drafting = (manifest: 'npm' | 'python') =>
  scripted({
    inspector: [
      {
        text: '',
        toolCalls: [manifest === 'npm' ? 'package.json' : 'pyproject.toml', 'CODEOWNERS', 'README.md'].map((file) => ({
          id: `read-${file}`,
          name: 'read_file',
          args: { path: file },
        })),
        finishReason: 'tool-calls',
      },
      call(REPORT_TOOL, FACTS),
    ],
    architect: [call(PROPOSE_TOOL, { operations: [COMPONENT] })],
  })

const run = async (args: string[], deps: Parameters<typeof main>[1] = {}) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    cwd: await temp(),
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** Every string a value holds, raw: never `JSON.stringify`, which escapes what it would hide. */
const leaves = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(leaves)
      : typeof value === 'object' && value !== null
        ? Object.values(value).flatMap(leaves)
        : []

const HEADING = /^discovery — what this repository's committed configuration states, read at commit [0-9a-f]{7};/

/** A coverage of a `git` walk, with `package.json` read and verified when `named`, and `README.md` not analysed when `inPart`. */
function coverage({ named, inPart }: { readonly named: boolean; readonly inPart: boolean }): Coverage {
  const bytes = Buffer.from(PACKAGE)
  const extracted = EXTRACTORS.npm('package.json', bytes)
  const reread = { path: 'package.json', bytes, committed: blobId(bytes, 'sha1'), objectFormat: 'sha1' as const }
  const context = { opened: new Set(['package.json']), extract: findingsOf(EXTRACTORS) }
  const checked =
    named && extracted.outcome === 'read' ? extracted.findings.map((finding) => verifyFinding(finding, reread, context)) : []
  return coverageOf(
    {
      selection: 'git',
      head: 'c0ffee1'.padEnd(40, '0'),
      opened: named ? ['package.json'] : [],
      notAnalysed: inPart ? [{ path: 'README.md', why: 'no-rule' }] : [],
      byDesign: [],
      untracked: 0,
      staged: 0,
      unlisted: 0,
      unnameable: 0,
      truncated: false,
    },
    new Map(named ? [['package.json', extracted]] : []),
    checked,
  )
}

const submitted = (outcome: SubmissionReport['outcome']): InitEnding => ({
  kind: 'submitted',
  report: { outcome } as SubmissionReport,
})

/** The table of Choices 1.4: each ending, and whether the rule turns its 0 into a 1. */
const ENDINGS: readonly (readonly [string, InitEnding, boolean])[] = [
  ['a preview', { kind: 'preview' }, true],
  ['nothing to change', { kind: 'nothing-to-change' }, true],
  ['unchanged', submitted('unchanged'), true],
  ['declined', submitted('declined'), true],
  ['created', submitted('created'), false],
  ['already-submitted', submitted('already-submitted'), false],
  ['already-proposed', submitted('already-proposed'), false],
  ['pushed-without-pull-request', submitted('pushed-without-pull-request'), false],
  ['closed', submitted('closed'), false],
  ['refused', submitted('refused'), false],
]

describe('initExit, the table of Choices 1.4', () => {
  it.each(ENDINGS)('%s: turns its 0 into a 1 only with no finding verified in a repository read in part', (_, ending, turned) => {
    const unverified = coverage({ named: false, inPart: true })
    expect(initExit(ending, true, unverified)).toBe(!turned)
    // Never a 1 into a 0.
    expect(initExit(ending, false, unverified)).toBe(false)
    // A verified finding, or a repository read whole, keeps every code.
    for (const kept of [coverage({ named: true, inPart: true }), coverage({ named: false, inPart: false })]) {
      expect(initExit(ending, true, kept)).toBe(true)
      expect(initExit(ending, false, kept)).toBe(false)
    }
  })
})

describe('init and the discovery report', () => {
  it('prints the report between the diff and how to apply it, and the diff still applies', async () => {
    const project = await service('npm')
    const result = await runInitRepo({ project, client: drafting('npm'), emit: () => {}, answers: TYPED })
    const lines = result.text.split('\n')
    const first = lines.findIndex((line) => HEADING.test(line))
    const diffEnd = lines.findLastIndex((line) => line.startsWith('+') && !line.startsWith('+++'))
    expect(first).toBeGreaterThan(diffEnd)
    const sentence = lines.findIndex((line) => line.startsWith('no dependency evidenced in '))
    expect(sentence).toBeGreaterThan(first)
    expect(lines.slice(first, sentence + 1)).not.toContain('')
    expect(lines.at(-1)).toBe(APPLY)

    const fresh = await temp()
    await cp(project, fresh, { recursive: true })
    await writeFile(path.join(fresh, 'catalog-info.diff'), `${result.text}\n`)
    execFileSync('git', ['apply', 'catalog-info.diff'], { cwd: fresh })
    expect(await git(fresh, 'status', '--porcelain', '--', 'catalog-info.yaml')).toBe('?? catalog-info.yaml')
  })

  it('exits 1 when no finding is verified and the repository was read in part, 0 when one is', async () => {
    const unverified = await service('python')
    const refused = await run(['init', '--repo', unverified, ...TYPED_FLAGS], { client: drafting('python') })
    expect(refused.code, refused.err).toBe(1)
    expect(refused.out).toContain('+++ b/catalog-info.yaml')
    expect(refused.out).toContain('+  name: billing-api')
    expect(refused.out).toMatch(/no rule for this format: .*pyproject\.toml/)
    expect(refused.out).toContain(
      'no dependency evidenced in 1 file analysed (no finding verified); 7 paths not analysed; 1 reference configured outside this repository',
    )

    const verified = await service('npm')
    const passed = await run(['init', '--repo', verified, ...TYPED_FLAGS], { client: drafting('npm') })
    expect(passed.code, passed.err).toBe(0)
    expect(passed.out).toContain(
      'no dependency evidenced in 2 files analysed (4 findings verified); 6 paths not analysed; 1 reference configured outside this repository',
    )
  })

  it.each([
    ['a name of 5', '{ "name": 5 }\n', 'a value this version could not read'],
    // An npm token's shape, inside npm's grammar for a name, assembled at run time.
    [
      'a name shaped like a credential',
      `{ "name": "${'np'}${'m_'}${'qz7placeholderabcdefghijklmnopqrstuv'.slice(0, 36)}" }\n`,
      'a value shaped like a credential, not shown',
    ],
  ])('exits 1 when the only finding that vouches is %s, which it lists and does not count', async (_, manifest, says) => {
    // Owner's answer 7 (2026-10-06): a name the engine could not read vouches
    // and states nothing, so it is listed as what it is and not counted.
    const project = await service('python', { 'package.json': manifest })
    const { code, out, err } = await run(['init', '--repo', project, ...TYPED_FLAGS], { client: drafting('python') })
    expect(code, err).toBe(1)
    expect(out).toContain('+  name: billing-api')
    expect(out).toContain(`package.json:1   ${says}`)
    const sentence =
      'no dependency evidenced in 2 files analysed (no finding verified); 7 paths not analysed; 1 reference configured outside this repository'
    expect(out.split('\n')).toContain(sentence)
    expect(err.split('\n')).toContain(sentence)
  })

  it('says the sentence on stderr too', async () => {
    const project = await service('python')
    const { err } = await run(['init', '--repo', project, ...TYPED_FLAGS], { client: drafting('python') })
    expect(err.split('\n')).toContain(
      'no dependency evidenced in 1 file analysed (no finding verified); 7 paths not analysed; 1 reference configured outside this repository',
    )
  })

  it('exits 0 once the branch is cut', async () => {
    const project = await service('python')
    await git(project, 'remote', 'add', 'origin', 'git@github.com:acme/billing-api.git')
    await git(project, 'config', 'branch.main.remote', 'origin')
    await git(project, 'config', 'branch.main.merge', 'refs/heads/main')
    const { code, out, err } = await run(['init', '--repo', project, '--submit', '--local', ...TYPED_FLAGS], {
      client: drafting('python'),
      gh: async () => {
        throw new Error('gh was started')
      },
    })
    expect(code, err).toBe(0)
    expect(out).toMatch(/1 file · submitted as idp-agent\/init-billing-api-[0-9a-f]{8} on top of main@[0-9a-f]{7}/)
    expect(out).toContain("(no finding verified)")
    expect(out.split('\n').some((line) => HEADING.test(line))).toBe(true)
  })

  it('carries the report after the engine’s block in the pull request’s body', { timeout: 30_000 }, async () => {
    const source = await files('npm')
    const clone = await githubClone({ source, repository: 'acme/billing-api' })
    const head = await git(clone.repo, 'rev-parse', 'HEAD')
    const out: string[] = []
    const code = await main(
      ['init', '--repo', clone.repo, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', 'dev', ...TYPED_FLAGS],
      {
        cwd: clone.repo,
        env: clone.env,
        gh: clone.gh.process,
        client: drafting('npm'),
        out: (chunk) => void out.push(chunk),
        err: () => {},
      },
    )
    expect(code).toBe(0)
    const posted = clone.gh.sent.filter(({ argv }) => argv.includes('POST'))
    expect(posted).toHaveLength(1)
    const { body = '' } = JSON.parse(posted[0]?.stdin?.toString('utf8') ?? '{}') as { body?: string }
    const lines = body.split('\n')
    const end = lines.indexOf(ENGINE_BLOCK_END)
    expect(end).toBeGreaterThan(-1)
    const report = lines.slice(end + 1).join('\n')
    expect(lines.slice(0, end).join('\n')).not.toContain('discovery —')
    expect(report).toContain(`read at commit \`${head.slice(0, 7)}\``)
    expect(report).toContain('`package.json`:2 the package is named `billing-api`')
    expect(report).toContain('`DATABASE_URL=mysql://app_billing:•••@localhost:3306/billing`')
    expect(lines.at(-1)).toBe(
      'no dependency evidenced in 2 files analysed (4 findings verified); 5 paths not analysed; 1 reference configured outside this repository',
    )
    expect(report).not.toMatch(/\/blob\/|https:\/\//)
  })

  it('opens the pull request at exit 0 with no finding verified', { timeout: 30_000 }, async () => {
    const source = await files('python')
    const clone = await githubClone({ source, repository: 'acme/billing-api' })
    const err: string[] = []
    const code = await main(
      ['init', '--repo', clone.repo, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', 'dev', ...TYPED_FLAGS],
      {
        cwd: clone.repo,
        env: clone.env,
        gh: clone.gh.process,
        client: drafting('python'),
        out: () => {},
        err: (chunk) => void err.push(chunk),
      },
    )
    expect(code, err.join('')).toBe(0)
    const posted = clone.gh.sent.filter(({ argv }) => argv.includes('POST'))
    expect(posted).toHaveLength(1)
    const { body = '' } = JSON.parse(posted[0]?.stdin?.toString('utf8') ?? '{}') as { body?: string }
    expect(body.split('\n').at(-1)).toMatch(/^no dependency evidenced in 1 file analysed \(no finding verified\); \d+ paths not analysed;/)
    expect(err.join('')).toContain('(no finding verified)')
  })

  it('sends no model a byte of what it read', async () => {
    const project = await service('npm')
    const client = drafting('npm')
    const { out } = await run(['init', '--repo', project, ...TYPED_FLAGS], { client })
    const discovered = [
      'app_billing',
      'localhost:3306/billing',
      'DATABASE_URL',
      '•••',
      'a sample states',
      'no dependency evidenced',
      'findings verified',
    ]
    // Not vacuous: each is in what the run printed.
    for (const text of discovered) expect(out, text).toContain(text)
    expect(client.seen.length).toBeGreaterThan(0)
    for (const request of client.seen) {
      for (const leaf of leaves(request)) {
        for (const text of discovered) expect(leaf.includes(text), `${text} sent to ${request.agent}`).toBe(false)
      }
    }
  })

  it('reports on nothing to change, by the same rule', async () => {
    const project = await service('python', { 'catalog-info.yaml': DECLARED })
    const { code, out } = await run(['init', '--repo', project, ...TYPED_FLAGS], { client: drafting('python') })
    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines.at(-1)).toBe('0 files · nothing written')
    const sentence = lines.findIndex((line) => line.startsWith('no dependency evidenced'))
    expect(lines[sentence]).toContain('(no finding verified)')
    expect(sentence).toBeGreaterThan(lines.findIndex((line) => line.includes('already declares')))
  })

  it('puts the report before the count of a preview that changes nothing', () => {
    const lines = renderPreview({
      signed: { plan: { intent: 'declare this service', operations: [] } } as never,
      edits: [],
      dropped: [],
      apply: APPLY,
      report: ['discovery — a heading', 'no dependency evidenced in 0 files analysed (no finding verified)'],
    }).text.split('\n')
    expect(lines.slice(-5)).toEqual([
      '',
      'discovery — a heading',
      'no dependency evidenced in 0 files analysed (no finding verified)',
      '',
      '0 files · nothing written',
    ])
  })

  it('prints no report on a question, and stays 3', async () => {
    const project = await service('python')
    const client = scripted({
      inspector: [call(REPORT_TOOL, { ...FACTS, owner: { unknown: 'no file names an owner' } })],
      architect: [
        call(PROPOSE_TOOL, {
          operations: [{ ...COMPONENT, entity: { ...COMPONENT.entity, spec: { ...COMPONENT.entity.spec, owner: { unknown: 'nobody said' } } } }],
        }),
      ],
    })
    const { code, out, err } = await run(['init', '--repo', project], { client })
    expect(code).toBe(3)
    expect(out).not.toContain('discovery —')
    expect(`${out}${err}`).not.toContain('no dependency evidenced')
  })

  it('exits 1 for a confirmation declined with no finding verified', async () => {
    const project = await service('python')
    const shown: string[] = []
    const said: string[] = []
    const result = await runInitRepo({
      project,
      client: drafting('python'),
      emit: () => {},
      answers: TYPED,
      notice: (line) => void said.push(line),
      submit: {
        confirm: async (summary) => {
          shown.push(summary.preview)
          return false
        },
      },
    })
    expect(result.found).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toMatch(/not submitted · nothing written/)
    // The report is in the preview the person declined, and its sentence on stderr.
    expect(shown.join('\n')).toContain('(no finding verified)')
    expect(said.some((line) => line.includes('(no finding verified)'))).toBe(true)
  })

  it('names no committed path raw in the trace', async () => {
    // git commits a name holding ESC, a line break or a format character as
    // readily as any other, and 1.2's read hands each to the report unchanged.
    const hostile = { 'a\u001b[31mred.md': 'x\n', 'line\nbreak.md': 'x\n', 'zero\u200Bwidth.md': 'x\n' }
    let project: string
    try {
      project = await service('npm', hostile)
    } catch {
      return // a filesystem that refuses such a name: nothing to read
    }
    const sink = memorySink()
    const { out } = await run(['init', '--repo', project, ...TYPED_FLAGS], { client: drafting('npm'), traceSinks: [sink] })
    const report = out.slice(out.search(/^discovery — /m))
    for (const spelled of ['a\\u001b[31mred.md', 'line\\u000abreak.md', 'zero\\u200bwidth.md']) {
      expect(report, spelled).toContain(spelled)
    }
    const trace = leaves(onlyTrace(sink))
    for (const raw of Object.keys(hostile)) {
      expect(trace.some((leaf) => leaf.includes(raw)), JSON.stringify(raw)).toBe(false)
    }
    // Where the trace holds the report, it holds the terminal's spelling.
    const copies = trace.filter((leaf) => leaf.includes('discovery — what this repository'))
    expect(copies.length).toBeGreaterThan(0)
    for (const copy of copies) {
      expect(copy).toContain('a\\u001b[31mred.md')
      expect(copy).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u)
    }
  })

  it('extracts nothing from a sample changed since HEAD', async () => {
    const project = await service('npm')
    await writeFile(path.join(project, '.env.example'), 'DATABASE_URL=postgres://app:Qz7x@edited.internal/x\n')
    const sink = memorySink()
    const { out, err } = await run(['init', '--repo', project, ...TYPED_FLAGS], { client: drafting('npm'), traceSinks: [sink] })
    expect(out).toContain('not committed: changed since HEAD: .env.example')
    expect(out).not.toMatch(/\.env\.example:\d/)
    const trace = leaves(onlyTrace(sink))
    for (const text of ['edited.internal', 'Qz7x']) {
      expect(out).not.toContain(text)
      expect(err).not.toContain(text)
      expect(trace.some((leaf) => leaf.includes(text))).toBe(false)
    }
  })
})
