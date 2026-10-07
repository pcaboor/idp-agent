import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, parseArguments } from '../../src/cli/index.js'
import { runInitRepo } from '../../src/cli/commands/init.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import { PROJECT_LIMITS, readProject } from '../../src/context/project-fs/snapshot.js'
import { budgetNotice } from '../../src/cli/repository.js'
import type { Question } from '../../src/core/plan/clarify.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import { hashTree } from '../support/tree.js'

/**
 * `init` on a service repository as one is actually shaped (review priority 9):
 * hundreds of files, a manifest that sorts after `app/`, a chart, a Dockerfile,
 * and a `catalog-info.yml` kept somewhere other than the root, written with no
 * `---`. Each test here failed on the `main` it was written against.
 */

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-init-real-'))

/** The coverage sentence of a run whose discovery verified no finding (stage 8, Task 1.4). */
const UNVERIFIED = /^no dependency evidenced in \d+ files? analysed \(no finding verified\); \d+ paths? not analysed; /m

async function tree(files: Record<string, string>): Promise<string> {
  const root = await temp()
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return root
}

/** `count` files under `folder`, named so they sort in the order they are made. */
const many = (folder: string, count: number, extension: string, body: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${folder}/f${String(index).padStart(3, '0')}${extension}`,
      body,
    ]),
  )

/** A Component as a person writes one: no `---`, an implicit first document. */
const componentDoc = (name: string): string =>
  [
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    '  type: service',
    '  lifecycle: production',
    '  owner: group:default/payments',
    '',
  ].join('\n')

const apiDoc = (name: string): string =>
  [
    'apiVersion: backstage.io/v1alpha1',
    'kind: API',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    '  type: openapi',
    '  lifecycle: production',
    '  owner: group:default/payments',
    '  definition: "openapi: 3.0.0"',
    '',
  ].join('\n')

const SIGNALS: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'billing-api', dependencies: { express: '^4.19.0' } }, null, 2)}\n`,
  Dockerfile: 'FROM node:22-alpine\nCOPY . .\nCMD ["node", "src/index.js"]\n',
  // Keys the facts `FACTS` reports that no manifest states: a value the
  // Inspector reports is kept only where a file it read states it.
  'README.md':
    '# billing-api\n\nBills customers.\n\ntype: service\nlifecycle: production\nowner: group:default/payments\n',
  CODEOWNERS: '* @acme/payments\n',
  'docker-compose.yml': 'services:\n  api:\n    build: .\n',
  'charts/billing-api/Chart.yaml': 'apiVersion: v2\nname: billing-api\nversion: 0.1.0\n',
  'charts/billing-api/values.yaml': 'replicaCount: 2\n',
  'charts/billing-api/values-prod.yaml': 'replicaCount: 4\n',
  'charts/billing-api/templates/deployment.yaml': 'kind: Deployment\n',
  'k8s/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\n',
}

/**
 * The realistic Node service: `app/` and `__generated__/` alone hold more than
 * the 200-file budget, and every signal but three sorts after them.
 */
const realistic = (extra: Record<string, string> = {}) =>
  tree({
    ...SIGNALS,
    ...many('__generated__', 120, '.ts', 'export {}\n'),
    ...many('app/components', 260, '.tsx', 'export const C = () => null\n'),
    ...many('src', 80, '.ts', 'export const x = 1\n'),
    ...many('test', 40, '.test.ts', 'it("works", () => {})\n'),
    ...extra,
  })

const TOTAL = Object.keys(SIGNALS).length + 120 + 260 + 80 + 40

describe('the budget is spent on the signal files first (gap-init-real-repos-1)', () => {
  it('reads the manifest, the chart, the Dockerfile and the deployments of a repository past its budget', async () => {
    const root = await realistic({ 'deploy/catalog-info.yml': componentDoc('billing-api') })
    const snapshot = await readProject(root)
    const paths = snapshot.files.map((file) => file.path)

    expect(snapshot.files).toHaveLength(PROJECT_LIMITS.maxFiles)
    expect(snapshot.truncated).toBe(true)
    for (const signal of [...Object.keys(SIGNALS), 'deploy/catalog-info.yml']) {
      expect(paths).toContain(signal)
    }
    // Chosen by signal, handed over in path order: the order the Inspector
    // has always been given, so a repository under the budget sends the
    // model exactly what it sent before.
    expect(paths).toEqual([...paths].sort())
  })

  it('counts what the budget left out, and names where it stopped', async () => {
    const root = await realistic()
    const snapshot = await readProject(root)

    expect(snapshot.leftOut).toBe(TOTAL - PROJECT_LIMITS.maxFiles)
    const stop = snapshot.skipped.find((entry) => entry.reason.includes('-file cap'))
    expect(stop?.reason).toContain(`${String(TOTAL - PROJECT_LIMITS.maxFiles)} `)
  })

  it('leaves a repository under the budget exactly as it read it before', async () => {
    const root = await tree({ 'src/index.ts': 'x\n', 'package.json': '{}\n', 'Dockerfile': 'FROM x\n' })
    const snapshot = await readProject(root)
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'Dockerfile',
      'package.json',
      'src/index.ts',
    ])
    expect(snapshot.leftOut).toBe(0)
    expect(snapshot.truncated).toBe(false)
  })

  it('says how many signal files the budget left out, rather than that they were read first', async () => {
    const root = await tree({
      ...SIGNALS,
      ...Object.fromEntries(
        Array.from({ length: 260 }, (_, index) => [
          `packages/p${String(index).padStart(3, '0')}/package.json`,
          '{}\n',
        ]),
      ),
    })
    const snapshot = await readProject(root)

    expect(snapshot.signalsLeftOut).toBeGreaterThan(0)
    const notice = budgetNotice(root, snapshot) ?? ''
    expect(notice).toContain(`${String(snapshot.signalsLeftOut)} of them`)
    expect(notice).not.toContain('were read first')

    const quiet = budgetNotice(root, await readProject(await realistic())) ?? ''
    expect(quiet).toContain('were read first')
  })

  it('reads every catalog-info whole and outside the budget', async () => {
    // 250 Kubernetes manifests one level down are signals too, and outrank a
    // catalog-info two levels down: it is out of the 200 files the model
    // reads, and still what `init` compares with.
    const root = await realistic({
      ...many('k8s', 250, '.yaml', 'kind: ConfigMap\n'),
      'platform/backstage/catalog-info.yaml': componentDoc('billing-api'),
    })
    const snapshot = await readProject(root)

    expect(snapshot.files.map((file) => file.path)).not.toContain(
      'platform/backstage/catalog-info.yaml',
    )
    expect(snapshot.declarations).toEqual([
      { path: 'platform/backstage/catalog-info.yaml', text: componentDoc('billing-api') },
    ])
  })
})

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

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/payments',
  forgeHandle: '@acme/payments',
  dependencies: [],
}

/**
 * What a person types for the four fields `FACTS` reads: since stage 8's
 * slice 2 (Task 2.1) what the Inspector reads is a hint beside a question and
 * never an answer, so a test that is about something else than the questions
 * gives the flags its run needs.
 */
const TYPED = { name: 'billing-api', type: 'service', lifecycle: 'production', owner: 'group:default/payments' } as const

/** What an inspection of a repository with no declaration can honestly say. */
const UNDECLARED = {
  ...FACTS,
  name: { unknown: 'no file states a catalogue name' },
  lifecycle: { unknown: 'no file states a lifecycle' },
  owner: { unknown: 'CODEOWNERS names a forge handle, not an entity reference' },
}

const component = (spec: Record<string, unknown> = {}, name = 'billing-api') => ({
  op: 'create-entity',
  entity: {
    kind: 'Component',
    metadata: { name },
    spec: {
      type: 'service',
      lifecycle: 'production',
      owner: 'group:default/payments',
      ...spec,
    },
  },
})

const UNSTATED = {
  lifecycle: { unknown: 'no file states one' },
  owner: { unknown: 'no file states an entity reference' },
}

/** The Inspector's first turn: the signal files that state what `FACTS` reports. */
const READING: GenerateResult = {
  text: '',
  toolCalls: ['package.json', 'README.md', 'CODEOWNERS', 'Dockerfile'].map((file) => ({
    id: `read-${file}`,
    name: 'read_file',
    args: { path: file },
  })),
  finishReason: 'tool-calls',
}

const drafting = (operations: unknown[], facts: unknown = FACTS) =>
  scripted({
    inspector: [READING, turnCalling(REPORT_TOOL, facts)],
    architect: [turnCalling(PROPOSE_TOOL, { operations })],
  })

describe('an existing catalog-info is recognised (gap-init-real-repos-3, core-yaml-4)', () => {
  it('finds the Component a nested catalog-info.yml declares with no ---, and adds nothing', async () => {
    const root = await realistic({ 'deploy/catalog-info.yml': componentDoc('billing-api') })
    const before = await hashTree(root)

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('deploy/catalog-info.yml already declares component:default/billing-api')
    expect(result.text).not.toContain('+++')
    expect(result.text).not.toContain('/dev/null')
    expect(await hashTree(root)).toBe(before)
  })

  it('recognises it before asking anything about it', async () => {
    // The owner is unknown to the inspection; the repository already says it.
    const root = await realistic({ 'deploy/catalog-info.yml': componentDoc('billing-api') })
    const asked: Question[] = []
    const ask: Ask = async (question) => {
      asked.push(question)
      return undefined
    }

    const result = await runInitRepo({
      project: root,
      client: drafting([component({ owner: UNSTATED.owner })]),
      emit: () => {},
      // The name, typed: what the Inspector read no longer settles it (Task 2.1).
      answers: { name: TYPED.name },
      ask,
    })

    expect(asked).toEqual([])
    expect(result.text).toContain('already declares component:default/billing-api')
  })

  it('finds a Component outside the files the model was given', async () => {
    const root = await realistic({
      ...many('k8s', 250, '.yaml', 'kind: ConfigMap\n'),
      'platform/backstage/catalog-info.yaml': componentDoc('billing-api'),
    })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    expect(result.text).toContain(
      'platform/backstage/catalog-info.yaml already declares component:default/billing-api',
    )
    expect(result.text).not.toContain('/dev/null')
  })

  it('does not call a same-named API "already declared"', async () => {
    // Kind + namespace + name, never the name alone.
    const root = await tree({ ...SIGNALS, 'catalog-info.yaml': apiDoc('billing-api') })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.text).not.toContain('already declares')
    expect(result.text).toContain('--- a/catalog-info.yaml')
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).toContain('+kind: Component')
    expect(result.text).not.toContain('/dev/null')
  })

  it('adds to the catalog-info.yml the repository keeps, never a .yaml beside it', async () => {
    const root = await tree({ ...SIGNALS, 'catalog-info.yml': componentDoc('billing-worker') })

    const result = await runInitRepo({
      project: root,
      client: drafting([component()]),
      emit: () => {},
      answers: TYPED,
    })

    expect(result.text).toContain('--- a/catalog-info.yml')
    expect(result.text).toContain('+++ b/catalog-info.yml')
    expect(result.text).toContain('+  name: billing-api')
    expect(result.text).not.toContain('catalog-info.yaml')
    expect(result.text).not.toContain('/dev/null')
  })

  it('compares with the root catalog-info.yaml on the disk, tracked or not', async () => {
    // The model is sent only what git tracks; what init would write over is
    // what the root holds, committed yet or not.
    const root = await tree({ ...SIGNALS, 'catalog-info.yaml': componentDoc('billing-api') })
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    )
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd: root,
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      })
    git('init', '-q')
    git('add', '--', ...Object.keys(SIGNALS))

    const snapshot = await readProject(root)
    expect(snapshot.selection).toBe('git')
    expect(snapshot.files.map((file) => file.path)).not.toContain('catalog-info.yaml')

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })
    expect(result.text).toContain('catalog-info.yaml already declares component:default/billing-api')
  })

  it('recognises a Component whose lifecycle this tool would not write, and says so', async () => {
    // Backstage accepts any lifecycle — its own import writes `unknown` — so a
    // service already registered there is declared, whatever this reader
    // holds a proposal to (review: an honest outcome, never a dead end).
    for (const lifecycle of ['unknown', 'stable']) {
      const imported = componentDoc('billing-api').replace(
        'lifecycle: production',
        `lifecycle: ${lifecycle}`,
      )
      const root = await tree({ ...SIGNALS, 'catalog-info.yaml': imported })

      const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

      // No finding verified, and the repository read in part — a folder git
      // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
      expect(result.found).toBe(false)
      expect(result.text).toMatch(UNVERIFIED)
      expect(result.unsupported).toBeUndefined()
      expect(result.text).toContain('catalog-info.yaml already declares component:default/billing-api')
      expect(result.text).toContain('lifecycle')
      expect(result.text).not.toContain('+++')
    }
  })

  it('recognises a Component whose name is written in upper case', async () => {
    // Backstage compares references case-insensitively: `Billing-Api` is
    // `billing-api`, and a lower-case one beside it is a conflicting twin.
    const root = await tree({ ...SIGNALS, 'catalog-info.yaml': componentDoc('Billing-Api') })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.text).toContain('catalog-info.yaml already declares component:default/Billing-Api')
    expect(result.text).not.toContain('+++')
  })

  it('does not call a same-named Resource or System "already declared"', async () => {
    for (const kind of ['Resource', 'System']) {
      const other = componentDoc('billing-api').replace('kind: Component', `kind: ${kind}`)
      const root = await tree({ ...SIGNALS, 'catalog-info.yaml': other })

      const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

      expect(result.text).not.toContain('already declares')
      expect(result.text).toContain('+++ b/catalog-info.yaml')
      expect(result.text).toContain('+kind: Component')
    }
  })

  it('reads the namespace a Component states, and names the ref the file declares', async () => {
    // Identity is kind + namespace + name: `component:payments/billing-api`
    // is not the `component:default/billing-api` init writes — and in the
    // service's own file it is most likely this service, so it is asked.
    const namespaced = componentDoc('billing-api').replace(
      '  name: billing-api',
      '  name: billing-api\n  namespace: payments',
    )
    const root = await tree({ ...SIGNALS, 'catalog-info.yaml': namespaced })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {} })

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain('component:payments/billing-api')
    expect(result.text).not.toContain('component:default/billing-api already')
    expect(result.text).toContain('--name')
    expect(result.text).not.toContain('+++')

    // Answered as that one: nothing to add.
    const ask: Ask = async () => 'billing-api'
    const answered = await runInitRepo({
      project: root,
      client: drafting([component()]),
      emit: () => {},
      ask,
    })
    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(answered.found).toBe(false)
    expect(answered.text).toMatch(UNVERIFIED)
    expect(answered.text).toContain('catalog-info.yaml already declares component:payments/billing-api')
    expect(answered.text).not.toContain('+++')
  })

  it('previews nothing over a catalog-info it could not read whole, and asks no model', async () => {
    const huge = `${componentDoc('billing-worker')}# ${'x'.repeat(PROJECT_LIMITS.maxFileBytes)}\n`
    const root = await tree({ ...SIGNALS, 'deploy/catalog-info.yml': huge })
    const client = drafting([component()])

    const result = await runInitRepo({ project: root, client, emit: () => {} })

    expect(result.found).toBe(false)
    expect(result.text).toContain('deploy/catalog-info.yml could not be read whole')
    expect(result.text).not.toContain('+++')
    expect(client.seen).toEqual([])
  })

  it('adds to a nested catalog-info.yml once the person names this service, compared with the whole of it', async () => {
    const root = await realistic({ 'deploy/catalog-info.yml': componentDoc('billing-worker') })

    const result = await runInitRepo({
      project: root,
      client: drafting([component()]),
      emit: () => {},
      answers: TYPED,
    })

    expect(result.text).toContain('--- a/deploy/catalog-info.yml')
    expect(result.text).toContain('+++ b/deploy/catalog-info.yml')
    expect(result.text).toContain('+  name: billing-api')
  })

  it('asks before adding a second Component to a file that declares one under another name', async () => {
    // One service, two names: the draft read `billing-api` in package.json,
    // the file says `billing`. Appending would declare the service twice.
    const root = await tree({ ...SIGNALS, 'catalog-info.yaml': componentDoc('billing') })
    // The other three fields typed: the name is the question here.
    const { name: _name, ...UNNAMED } = TYPED

    const unasked = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: UNNAMED })
    expect(unasked.unsupported).toBe(true)
    expect(unasked.text).toContain('catalog-info.yaml already declares component:default/billing')
    expect(unasked.text).toContain('--name')
    expect(unasked.text).not.toContain('+++')

    // "It is that one": nothing to change.
    const same = await runInitRepo({
      project: root,
      client: drafting([component()]),
      emit: () => {},
      answers: UNNAMED,
      ask: async () => 'billing',
    })
    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(same.found).toBe(false)
    expect(same.text).toMatch(UNVERIFIED)
    expect(same.text).toContain('catalog-info.yaml already declares component:default/billing')
    expect(same.text).not.toContain('+++')

    // "It is another": the person named it, and it is added.
    const other = await runInitRepo({
      project: root,
      client: drafting([component()]),
      emit: () => {},
      answers: UNNAMED,
      ask: async () => 'billing-api',
    })
    expect(other.found).toBe(false)
    expect(other.text).toMatch(UNVERIFIED)
    expect(other.text).toContain('+++ b/catalog-info.yaml')
    expect(other.text).toContain('+  name: billing-api')
  })

  it('never files the service in a test fixture\'s catalog-info', async () => {
    const root = await tree({
      ...SIGNALS,
      'test/fixtures/catalog-info.yaml': componentDoc('fixture-svc'),
    })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.text).toContain('--- /dev/null')
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).not.toContain('test/fixtures/catalog-info.yaml')
  })

  it('never files the service in a hidden folder\'s catalog-info', async () => {
    // `.github` is the one hidden folder the walk reads, and a plan naming a
    // path in a hidden folder is refused at the schema (gap-stage5-readiness-2):
    // the file init chooses is one a Plan may carry, or the run would end on
    // "the composed plan is not a plan".
    const root = await tree({
      ...SIGNALS,
      '.github/catalog-info.yaml': componentDoc('gh-svc'),
    })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.text).toContain('--- /dev/null')
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).not.toContain('b/.github/catalog-info.yaml')
  })

  it('never files the service in a workspace\'s catalog-info', async () => {
    const root = await tree({
      ...SIGNALS,
      'packages/web/package.json': '{ "name": "web" }\n',
      'packages/web/catalog-info.yaml': componentDoc('web'),
    })

    const result = await runInitRepo({ project: root, client: drafting([component()]), emit: () => {}, answers: TYPED })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.text).toContain('--- /dev/null')
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).not.toContain('b/packages/web/catalog-info.yaml')
  })

  it('is not stopped by a catalog-info that is neither the service\'s nor where it would write', async () => {
    const huge = `${componentDoc('other')}# ${'x'.repeat(PROJECT_LIMITS.maxFileBytes)}\n`
    const cases: Record<string, string>[] = [
      { 'docs/catalog-info-all.yaml': huge },
      { 'examples/big/catalog-info.yaml': huge },
      { 'charts/billing/templates/catalog-info.yaml': 'metadata:\n  name: {{ .Values.name }}\n  x: {{ y }}\n' },
      { 'test/fixtures/catalog-info.yaml': 'metadata:\n  name: [unclosed\n' },
    ]
    for (const extra of cases) {
      const root = await tree({ ...SIGNALS, ...extra })
      const notices: string[] = []

      const result = await runInitRepo({
        project: root,
        client: drafting([component()]),
        emit: () => {},
        answers: TYPED,
        notice: (line) => void notices.push(line),
      })

      // No finding verified, and the repository read in part — a folder git
      // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
      expect(result.found).toBe(false)
      expect(result.text).toMatch(UNVERIFIED)
      expect(result.text).toContain('+++ b/catalog-info.yaml')
      const [file] = Object.keys(extra)
      if (file === 'docs/catalog-info-all.yaml') {
        expect(notices.join('\n')).toContain(`${file} could not be read`)
      }
    }
  })

  it('stops, before any model, on a catalog-info at the root it cannot read', async () => {
    const root = await tree({ ...SIGNALS, 'catalog-info.yaml': 'metadata:\n  name: [unclosed\n' })
    const client = drafting([component()])

    const result = await runInitRepo({ project: root, client, emit: () => {} })

    expect(result.found).toBe(false)
    expect(result.text).toContain('catalog-info.yaml')
    expect(result.text).not.toContain('+++')
    expect(client.seen).toEqual([])
  })
})

describe('questions init cannot answer are asked, or answered by flags (gap-init-real-repos-2)', () => {
  const undeclaredDraft = () =>
    drafting([component(UNSTATED)], UNDECLARED)

  it('reaches a diff when the person passes --owner, --lifecycle and --name', async () => {
    const root = await realistic()
    const before = await hashTree(root)
    const out: string[] = []
    const err: string[] = []

    const code = await main(
      [
        'init',
        '--repo',
        root,
        '--owner',
        'group:default/payments',
        '--lifecycle',
        'production',
        '--name',
        'billing-api',
        '--type',
        'service',
      ],
      {
        client: undeclaredDraft(),
        out: (chunk) => void out.push(chunk),
        err: (chunk) => void err.push(chunk),
      },
    )

    const text = out.join('')
    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(code).toBe(1)
    expect(text).toMatch(UNVERIFIED)
    expect(text).toContain('--- /dev/null')
    expect(text).toContain('+++ b/catalog-info.yaml')
    expect(text).toContain('+  name: billing-api')
    expect(text).toContain('+  lifecycle: production')
    expect(text).toContain('+  owner: group:default/payments')
    expect(await hashTree(root)).toBe(before)
  })

  it('states on stderr what the budget left out, counted', async () => {
    const root = await realistic()
    const err: string[] = []

    await main(['init', '--repo', root], {
      client: undeclaredDraft(),
      out: () => {},
      err: (chunk) => void err.push(chunk),
    })

    expect(err.join('')).toContain(
      `read ${String(PROJECT_LIMITS.maxFiles)} files of ${path.basename(root)} and left ` +
        `${String(TOTAL - PROJECT_LIMITS.maxFiles)} out`,
    )
  })

  it('reaches a diff when the person answers at the prompt', async () => {
    const root = await realistic()
    const asked: Question[] = []
    const answers: Record<string, string> = {
      'metadata.name': 'billing-api',
      'spec.type': 'service',
      'spec.lifecycle': 'production',
      'spec.owner': 'group:default/payments',
    }
    const ask: Ask = async (question) => {
      asked.push(question)
      const field = Object.keys(answers).find((suffix) => question.path.endsWith(suffix))
      return field === undefined ? undefined : answers[field]
    }

    const result = await runInitRepo({ project: root, client: undeclaredDraft(), emit: () => {}, ask })

    // No finding verified, and the repository read in part — a folder git
    // does not hold: exit 1, the coverage sentence said (stage 8, Task 1.4).
    expect(result.found).toBe(false)
    expect(result.text).toMatch(UNVERIFIED)
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).toContain('+  owner: group:default/payments')
    // #72's prompt: the draft's value, as the draft's, and the values a
    // closed field accepts.
    const name = asked.find((question) => question.path.endsWith('metadata.name'))
    expect(name?.proposed).toBe('billing-api')
    const lifecycle = asked.find((question) => question.path.endsWith('spec.lifecycle'))
    expect(lifecycle?.accepted).toEqual(['experimental', 'production', 'deprecated'])
  })

  it('puts a lifecycle outside the set back to the person, naming it', async () => {
    const root = await realistic()
    const seen: Question[] = []
    const ask: Ask = async (question) => {
      seen.push(question)
      if (question.path.endsWith('spec.lifecycle')) {
        return question.refused === undefined ? 'prod' : 'production'
      }
      if (question.path.endsWith('spec.owner')) return 'group:default/payments'
      return 'billing-api'
    }

    const result = await runInitRepo({ project: root, client: undeclaredDraft(), emit: () => {}, ask })

    expect(seen.some((question) => question.refused === 'prod')).toBe(true)
    expect(result.text).toContain('+  lifecycle: production')
  })

  it('with nobody to ask, names the flags that answer the questions', async () => {
    const root = await realistic()

    const result = await runInitRepo({ project: root, client: undeclaredDraft(), emit: () => {} })

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain('operations.0.entity.spec.owner')
    expect(result.text).toContain('accepted: experimental, production, deprecated')
    expect(result.text).toContain('--owner')
    expect(result.text).toContain('--lifecycle')
    expect(result.text).toContain('--name')
    expect(result.text).not.toContain('Fill them in')
  })

  it('after a decline at the terminal, names only the flags', async () => {
    const root = await realistic()

    const result = await runInitRepo({
      project: root,
      client: undeclaredDraft(),
      emit: () => {},
      ask: async () => undefined,
    })

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain('--owner')
    expect(result.text).not.toContain('at a terminal')
  })

  it('holds a flag to what the field accepts, before a model is chosen', async () => {
    for (const [flag, value] of [
      ['--lifecycle', 'prod'],
      ['--owner', '@acme/payments'],
      ['--name', 'Billing API'],
    ] as const) {
      const err: string[] = []
      const code = await main(['init', flag, value], {
        cwd: await temp(),
        out: () => {},
        err: (chunk) => void err.push(chunk),
      })
      expect(code).toBe(2)
      expect(err.join('')).toContain(flag)
    }
  })

  it('parses the three flags beside --repo', () => {
    expect(
      parseArguments([
        'init',
        '--repo',
        'svc',
        '--owner',
        'group:default/payments',
        '--lifecycle',
        'experimental',
        '--name',
        'billing-api',
      ]),
    ).toEqual({
      name: 'init',
      repo: 'svc',
      answers: { owner: 'group:default/payments', lifecycle: 'experimental', name: 'billing-api' },
    })
    expect(parseArguments(['init'])).toEqual({ name: 'init', answers: {} })
  })
})
