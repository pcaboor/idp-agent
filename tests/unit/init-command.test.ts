import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { catalogInfoEdits, runInitRepo } from '../../src/cli/commands/init.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { checkRepository } from '../../src/core/validate/rules.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import { hashTree } from '../support/tree.js'
import { listDocumentNames } from '../../src/core/yaml/surgery.js'

const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })
const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-init-'))

const init = async (args: string[], cwd?: string) => {
  const io = capture()
  const code = await main(args, {
    // Omitted rather than passed as undefined: exactOptionalPropertyTypes
    // draws the distinction.
    ...(cwd !== undefined ? { cwd } : {}),
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

describe('init platform', () => {
  it('scaffolds a repository that passes its own validator', async () => {
    // The round trip, and the one failure this stage cannot ship: a scaffold
    // its own rules reject. Two independent oracles.
    const root = await temp()
    const { code, out } = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    expect(code).toBe(0)
    expect(out).toContain('wrote 12')

    const built = path.join(root, 'repo')
    expect(checkRepository(await readRepository(built))).toEqual([])

    const loaded = await new FixtureProvider(built).load()
    expect(loaded.entities).toEqual([])
    expect(loaded.rejected).toEqual([])
  })

  it('writes nothing on a re-run and keeps a hand edit', async () => {
    const root = await temp()
    await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    const owners = path.join(root, 'repo/CODEOWNERS')
    await writeFile(owners, '* @someone/else\n')

    const { code, out } = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    expect(code).toBe(0)
    expect(out).toContain('wrote 0')
    expect(out).toContain('kept 12')
    expect(await readFile(owners, 'utf8')).toBe('* @someone/else\n')
  })

  it('prints the branch protection it cannot set, on every run', async () => {
    // "An automaton that verifies its own powerlessness, out loud." The
    // no-op run must say it too, or the second reader never sees it.
    const root = await temp()
    const first = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    const second = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    for (const run of [first, second]) {
      expect(run.out).toContain('Branch protection is set in the forge')
      expect(run.out).toMatch(/cannot verify/i)
      expect(run.out).toContain('stage 6')
    }
  })

  it('needs an owner, and says what one looks like', async () => {
    const root = await temp()
    const { code, err } = await init(['init', 'platform', 'repo'], root)
    expect(code).toBe(2)
    expect(err).toContain('--owner')
    expect(err).toContain('@')
  })

  it('refuses an entity owner reference, which is a different notation', async () => {
    const root = await temp()
    const { code, err } = await init(
      ['init', 'platform', 'repo', '--owner', 'group:default/tiger'],
      root,
    )
    expect(code).toBe(2)
    expect(err).toContain('group:default/tiger')
  })

  it('creates the repository where it was told to, absolute path included', async () => {
    // `init platform` CREATES the repository: its root has no reason to sit
    // under the working directory, and `idp-agent init platform ~/my-iac` is
    // the first thing anyone types. Containment belongs to the files written
    // UNDER that root — `write.ts` checks every one of them against it — not
    // to the root the user named in their own shell.
    const elsewhere = path.join(await temp(), 'somewhere-else')
    const cwd = await temp()

    const { code } = await init(['init', 'platform', elsewhere, '--owner', '@a/b'], cwd)

    expect(code).toBe(0)
    // The witness of the folder layout itself, read straight off the disk:
    // readRepository reports catalogue documents, and a fresh scaffold has
    // none — the folders and their witnesses are what it wrote.
    expect(await readFile(path.join(elsewhere, 'README.md'), 'utf8')).toContain('#')
  })

  it('writes every file under the root it was given, and none outside it', async () => {
    // The containment that actually matters, asserted where it lives.
    const root = path.join(await temp(), 'iac')
    await init(['init', 'platform', root, '--owner', '@a/b'], await temp())

    // Every path the scaffold reports is repository-relative, and every one of
    // them resolves back under the root it was given.
    const { out } = await init(['init', 'platform', root, '--owner', '@a/b'], await temp())
    const listed = out
      .split('\n')
      .filter((line) => /^ {2}[+=] /.test(line))
      .map((line) => line.slice(4))

    expect(listed.length).toBeGreaterThan(0)
    for (const file of listed) {
      expect(path.isAbsolute(file)).toBe(false)
      expect(file.split('/')).not.toContain('..')
      expect(path.resolve(root, file).startsWith(`${root}${path.sep}`)).toBe(true)
    }
  })

  it('needs a directory', async () => {
    const { code, err } = await init(['init', 'platform', '--owner', '@a/b'])
    expect(code).toBe(2)
    expect(err).toContain('directory')
  })
})

/**
 * Replays a scripted sequence of model turns, keyed by AGENT — the same helper
 * `plan-intent.test.ts` uses, and for the same reason: no recording, no key,
 * and no dependence on how many turns the agent before it happened to spend.
 */
const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      // Copied, not kept by reference: the agent loops go on pushing into the
      // very array they handed over, so a stored request would report the
      // transcript as it ended rather than as that turn saw it.
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

/** The opening message of a request. Narrowed: a tool entry carries no text. */
const openingOf = (request: GenerateRequest | undefined): string => {
  const first = request?.transcript[0]
  return first !== undefined && first.role === 'user' ? first.text : ''
}

/** One application repository, with the two files an Inspector looks for. */
const application = async (): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api' }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '* @acme/platform\n', 'utf8')
  return root
}

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [],
}

const COMPONENT = {
  op: 'create-entity',
  entity: {
    kind: 'Component',
    metadata: { name: 'billing-api' },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  },
}

const drafting = (operations: unknown[], facts: unknown = FACTS) =>
  scripted({
    inspector: [turnCalling(REPORT_TOOL, facts)],
    architect: [turnCalling(PROPOSE_TOOL, { operations })],
  })

describe('init, per application', () => {
  it('previews the catalog-info.yml it would write, and writes nothing', async () => {
    // §7.3, finally answered. The refusal stage 3 shipped named the Inspector
    // and propose(); both exist now.
    const project = await application()
    const before = await hashTree(project)

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
    })

    expect(result.found).toBe(true)
    expect(result.text).toContain('--- /dev/null')
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).toContain('kind: Component')
    expect(result.text).toContain('+  name: billing-api')
    expect(result.text).toContain('lifecycle: production')
    expect(result.text.trimEnd()).toContain(
      'Nothing is provisioned yet. The merge is what authorises it.',
    )
    expect(await hashTree(project)).toBe(before)
  })

  it('files it where the engine says, never where the model does', async () => {
    // §5.2. The propose tool has no `create-catalog-info` member at all, so
    // there is no `repoPath` field in front of the model; the engine mints the
    // operation from the directory it was pointed at.
    const project = await application()
    const before = await hashTree(project)
    const client = drafting([COMPONENT])

    const result = await runInitRepo({ project, client, emit: () => {} })

    const draft = client.seen.find((request) => request.agent === 'architect')
    const proposeTool = draft?.tools.find((spec) => spec.name === PROPOSE_TOOL)
    expect(proposeTool).toBeDefined()
    expect(JSON.stringify(draft?.tools)).not.toContain('repoPath')
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(await hashTree(project)).toBe(before)
  })

  it('refuses anything that is not this repository’s own declaration', async () => {
    // "Restricted to create-catalog-info" is structural: the engine can only
    // mint that operation out of a Component, so a Resource has nowhere to go.
    const project = await application()
    const before = await hashTree(project)
    const client = drafting([
      {
        op: 'create-entity',
        entity: {
          kind: 'Resource',
          metadata: { name: 'billing-api-db-prod', env: 'prod' },
          spec: { type: 'database', owner: 'group:default/tiger' },
        },
      },
    ])

    const result = await runInitRepo({ project, client, emit: () => {} })

    expect(result.found).toBe(false)
    expect(result.text).toMatch(/operations\.0/)
    expect(result.text).not.toContain('@@')
    expect(await hashTree(project)).toBe(before)
  })

  it('asks about a fact the repository never stated, rather than filling it in', async () => {
    // The guarantee that survives composing the request from the inspection:
    // a value no fact states is vouched for by nothing and becomes a question.
    const project = await application()
    const before = await hashTree(project)
    const client = drafting(
      [COMPONENT],
      { ...FACTS, owner: { unknown: 'no file states an entity reference for the owner' } },
    )

    const result = await runInitRepo({ project, client, emit: () => {} })

    expect(result.unsupported).toBe(true)
    expect(result.found).toBe(false)
    expect(result.text).toContain('operations.0.entity.spec.owner')
    expect(result.text).not.toContain('@@')
    expect(await hashTree(project)).toBe(before)
  })

  it('asks about a type the inspection never established', async () => {
    // `requestOf` names exactly the four values `proposedComponentSchema` lets
    // a model write, and claims that a name, a type, a lifecycle or an owner
    // the Architect INVENTS becomes a question. The type was the one of the
    // four that did not: it classified structurally, on the strength of a
    // closed union a Component's `spec.type` is not — 63 characters of free
    // text, straight into `catalog-info.yaml`.
    const project = await application()
    const before = await hashTree(project)
    const invented = {
      ...COMPONENT,
      entity: {
        ...COMPONENT.entity,
        spec: { ...COMPONENT.entity.spec, type: 'anything-the-model-likes' },
      },
    }

    const result = await runInitRepo({ project, client: drafting([invented]), emit: () => {} })

    expect(result.unsupported).toBe(true)
    expect(result.found).toBe(false)
    expect(result.text).toContain('operations.0.entity.spec.type')
    expect(result.text).not.toContain('anything-the-model-likes')
    expect(result.text).not.toContain('catalog-info.yaml')
    expect(await hashTree(project)).toBe(before)
  })

  it('never turns a forge handle into an owner, even through the request', async () => {
    // `@acme/platform` and `group:default/platform` are different namespaces,
    // and the CODEOWNERS entry is the one fact that must not reach spec.owner.
    const project = await application()
    const before = await hashTree(project)
    const client = drafting([COMPONENT])

    await runInitRepo({ project, client, emit: () => {} })

    const draft = client.seen.find((request) => request.agent === 'architect')
    expect(openingOf(draft)).toContain('@acme/platform')
    // It is stated to the model as a forge handle, and it is absent from the
    // request the signature measures provenance against.
    expect(openingOf(draft).split('\n\n')[0]).not.toContain('@acme/platform')
    expect(await hashTree(project)).toBe(before)
  })

  it('refuses a run with no model configured, in providers.ts’s own words', async () => {
    const project = await application()
    const { code, err } = await init(['init', '--repo', project], await temp())

    expect(code).toBe(2)
    expect(err).toContain('no model configured: set IDP_PROVIDER (one of ')
  })

  it('reads the repository it is standing in when told no other', async () => {
    // §7.3 is run once per application, from inside it.
    const project = await application()
    const { code, err } = await init(['init'], project)

    expect(code).toBe(2)
    expect(err).toContain('no model configured')
  })
})

describe('two components, one catalog-info.yaml', () => {
  it('emits one edit for the file, carrying both', () => {
    // Tested on the function rather than through the command, because the
    // command cannot reach it today: `ProjectFacts` holds ONE name, so a
    // second component is a name the inspection never established and the
    // signature turns it into a question first. That is the outer guarantee
    // holding, not this one — and a composition rule that only works because
    // something upstream happens to refuse is a rule waiting for the day it
    // does not.
    //
    // Every `create-catalog-info` in a plan points at the SAME file. One edit
    // per operation printed two "create this from /dev/null" hunks for one
    // path, each computed against the untouched original, and called it two
    // files — the defect `core/plan/edits.ts` documents and avoids by keying
    // its buffer on PATH.
    const componentOf = (name: string) => ({
      op: 'create-catalog-info' as const,
      repoPath: 'catalog-info.yaml',
      entity: {
        kind: 'Component' as const,
        metadata: { name },
        spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
      },
    })

    const edits = catalogInfoEdits(
      {
        intent: 'declare this service',
        operations: [componentOf('billing-api'), componentOf('billing-worker')],
      } as never,
      { files: [] },
    )

    expect(edits).toHaveLength(1)
    expect(edits[0]?.path).toBe('catalog-info.yaml')
    expect(edits[0]?.before).toBeUndefined()
    expect(listDocumentNames(edits[0]?.after ?? '')).toEqual(['billing-api', 'billing-worker'])
  })
})
