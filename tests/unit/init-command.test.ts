import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { previewOf, runInitRepo } from '../../src/cli/commands/init.js'
import { renderPreview } from '../../src/cli/commands/plan.js'
import { catalogInfoEdits } from '../../src/core/plan/catalog-info.js'
import { signPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { IacFsProvider } from '../../src/context/iac-fs/provider.js'
import { renderRegistration } from '../../src/core/validate/registration.js'
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
import { committed, git, observable, show, stored } from '../support/git.js'
import { ConfigError, readConfig } from '../../src/cli/config.js'
import { CONFIG_FILE, serializeConfig } from '../../src/core/schemas/config.js'
import { listDocumentNames } from '../../src/core/yaml/surgery.js'
import { MERGE_NOTE, protectionText } from '../../src/core/github/protection.js'
import type { GhProcess } from '../../src/process/gh.js'
import type { SubmissionSummary } from '../../src/cli/commands/submit.js'
import { removeClones } from '../support/forge-fixture.js'
import { githubClone, moveGitHubBase, pullRequestBy, unprotect } from '../support/github-fixture.js'

/** The line a preview of `init` ends on, in place of `plan`'s about the merge. */
const INIT_CLOSING =
  "Nothing is written. To write it, save a run to a file, read it, and apply that file in the " +
  "service's repository — another run may draft other bytes than these: " +
  'idpa init > catalog-info.diff, then git apply catalog-info.diff'

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
    expect(out).toContain('wrote 13')

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
    expect(out).toContain('kept 13')
    expect(await readFile(owners, 'utf8')).toBe('* @someone/else\n')
  })

  it('says what it wrote before a write failed, and exits 1', async () => {
    // A file where a folder belongs: `.github` cannot hold `workflows/`. The
    // run used to throw out of `main` naming the file it could not write and
    // none of the eight it already had (gap-stage5-readiness-7).
    const root = await temp()
    await mkdir(path.join(root, 'repo'))
    await writeFile(path.join(root, 'repo/.github'), 'not a folder\n')

    const { code, out, err } = await init(
      ['init', 'platform', 'repo', '--owner', '@acme/platform'],
      root,
    )

    expect(code).toBe(1)
    // stdout stays the file list; the sentence about the failure is a person's.
    expect(out).toContain('wrote 8 · kept 0')
    expect(out).toContain('+ schemas/plan.schema.json')
    expect(out).not.toContain('+ CODEOWNERS')
    expect(out).not.toContain('could not write')
    expect(err).toContain('could not write .github/workflows/validate.yml')
    // What was written is on the disk, and said to be kept by a re-run.
    expect(await readFile(path.join(root, 'repo/schemas/plan.schema.json'), 'utf8')).toContain('{')
    expect(err).toContain('run it again')
  })

  it('refuses a directory that is a file, exit 2, before writing anything', async () => {
    // It was a failed write under it, exit 1, naming the first scaffold file
    // rather than the argument — and before that an unhandled rejection.
    const root = await temp()
    await writeFile(path.join(root, 'repo'), 'x\n')

    const { code, out, err } = await init(
      ['init', 'platform', 'repo', '--owner', '@acme/platform'],
      root,
    )

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('repo is not a directory')
    expect(await readFile(path.join(root, 'repo'), 'utf8')).toBe('x\n')
  })

  it('prints the ruleset idpa protection checks, on every run', async () => {
    // "An automaton that verifies its own powerlessness, out loud." The
    // no-op run must say it too, or the second reader never sees it. The list
    // is the one idpa protection checks and a refused submission prints, so
    // the three cannot drift.
    const root = await temp()
    const first = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    const second = await init(['init', 'platform', 'repo', '--owner', '@acme/platform'], root)
    for (const run of [first, second]) {
      expect(run.out).toContain(
        [
          'Branch protection is set in the forge, not here. Add a ruleset on the default branch (Settings → Rules → Rulesets):',
          ...protectionText(),
          'idpa protection checks them once the repository is on GitHub.',
        ].join('\n'),
      )
      expect(run.out).not.toContain('stage 6')
      expect(run.out).not.toMatch(/cannot verify/i)
      // ADR-0012: a downstream refusal must never merge, once one reports.
      expect(run.out).toContain('required status check')
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

  it('writes the Backstage registration at the root, and the read commands say nothing of it', async () => {
    // One `catalog.locations` entry ingests the repository. It is this
    // repository's own wiring, not a document of somebody else's catalogue:
    // no warning in `validate`, no set-aside line in `graph`, `show` or `ask`.
    const root = await temp()
    await init(['init', 'platform', 'platform-iac', '--owner', '@acme/platform'], root)
    const built = path.join(root, 'platform-iac')

    expect(await readFile(path.join(built, 'catalog-info.yaml'), 'utf8')).toBe(
      renderRegistration('platform-iac'),
    )
    const loaded = await new IacFsProvider(built).load()
    expect(loaded.ignored).toEqual([])
    expect(loaded.rejected).toEqual([])
  })

  it('keeps a root catalog-info.yaml that is there, and prints on stderr the Location it needs', async () => {
    const root = await temp()
    const built = path.join(root, 'repo')
    await mkdir(built)
    const theirs =
      'apiVersion: backstage.io/v1alpha1\nkind: System\nmetadata:\n  name: payments\n'
    await writeFile(path.join(built, 'catalog-info.yaml'), theirs)

    const { code, out, err } = await init(['init', 'platform', 'repo', '--owner', '@a/b'], root)

    expect(code).toBe(0)
    expect(await readFile(path.join(built, 'catalog-info.yaml'), 'utf8')).toBe(theirs)
    expect(out).toContain('= catalog-info.yaml')
    expect(err).toContain('catalog-info.yaml')
    expect(err).toContain(renderRegistration('repo'))
    // stdout stays what a script reads: the files, and the branch protection.
    expect(out).not.toContain('kind: Location')
  })

  it('says the same of a kept Location that leaves a folder out', async () => {
    const root = await temp()
    const built = path.join(root, 'repo')
    await mkdir(built)
    await writeFile(
      path.join(built, 'catalog-info.yaml'),
      'apiVersion: backstage.io/v1alpha1\nkind: Location\nmetadata:\n  name: repo\n' +
        'spec:\n  targets:\n    - ./catalog/**/*.yml\n',
    )
    const { code, err } = await init(['init', 'platform', 'repo', '--owner', '@a/b'], root)
    expect(code).toBe(0)
    expect(err).toContain(renderRegistration('repo'))
  })

  it('says a kept root file it cannot read could not be read, not that it holds no Location', async () => {
    const root = await temp()
    const built = path.join(root, 'repo')
    await mkdir(built)
    await writeFile(path.join(built, 'catalog-info.yaml'), 'key: [unclosed\n')
    const { code, err } = await init(['init', 'platform', 'repo', '--owner', '@a/b'], root)
    expect(code).toBe(0)
    expect(err).not.toContain('holds no Location')
    expect(err).toContain('does not read')
    expect(err).toContain('idp-agent validate')
    expect(err).toContain(renderRegistration('repo'))
  })

  it('says a kept root catalog-info.yaml that is no regular file is not read', async () => {
    const root = await temp()
    const built = path.join(root, 'repo')
    await mkdir(built)
    await writeFile(path.join(root, 'elsewhere.yaml'), renderRegistration('repo'))
    await symlink(path.join(root, 'elsewhere.yaml'), path.join(built, 'catalog-info.yaml'))
    const { code, err } = await init(['init', 'platform', 'repo', '--owner', '@a/b'], root)
    expect(code).toBe(0)
    expect(err).not.toContain('holds no Location')
    expect(err).toContain('not a regular file')
    expect(err).toContain(renderRegistration('repo'))
  })

  it('says nothing on stderr when the kept file is its own registration', async () => {
    const root = await temp()
    await init(['init', 'platform', 'repo', '--owner', '@a/b'], root)
    const { code, out, err } = await init(['init', 'platform', 'repo', '--owner', '@a/b'], root)
    expect(code).toBe(0)
    expect(out).toContain('kept 13')
    expect(err).toBe('')
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

/**
 * One application repository, with the two files an Inspector looks for — and
 * its `.idp-agent.yml`, when a test hands one, as `plan-intent.test.ts`'s does.
 */
const application = async (config?: string): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api' }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, 'CODEOWNERS'), '* @acme/platform\n', 'utf8')
  if (config !== undefined) await writeFile(path.join(root, CONFIG_FILE), config, 'utf8')
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
  it('previews the catalog-info.yaml it would write, and writes nothing', async () => {
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
    // Its own last line: no merge in the declarations repository authorises
    // a service's catalog-info, and "the merge" sent nobody anywhere (review,
    // gap-init-real-repos-8).
    expect(result.text.trimEnd().split('\n').at(-1)).toBe(INIT_CLOSING)
    expect(result.text).not.toContain('The merge is what authorises it')
    expect(await hashTree(project)).toBe(before)
  })

  it('ends on how to apply its diff, and that is how it applies', async () => {
    // What the last line says, done: stdout saved to a file, and the file
    // handed to git apply in the service's repository, the lines around the
    // diff included. A file, not a pipe: `idpa init | git apply` runs the
    // models again, and applies bytes nobody read.
    const project = await application()
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {} })
    expect(result.text).toContain('idpa init > catalog-info.diff, then git apply catalog-info.diff')
    expect(result.text).not.toContain('| git apply')

    execFileSync('git', ['init', '--quiet'], { cwd: project })
    await writeFile(path.join(project, 'catalog-info.diff'), `${result.text}\n`)
    execFileSync('git', ['apply', 'catalog-info.diff'], { cwd: project })

    const written = await readFile(path.join(project, 'catalog-info.yaml'), 'utf8')
    expect(written).toContain('kind: Component')
    expect(written).toContain('  name: billing-api')
  })

  it('ends an empty preview on its count: with nothing to apply, no line says how', () => {
    // `renderPreview` with init's `apply`, over edits that change nothing. The
    // closing about the merge is plan's, and was never true of a catalog-info;
    // the line about git apply has nothing to apply.
    const empty = (apply?: string) =>
      renderPreview({
        signed: { plan: { intent: 'declare this service', operations: [] } } as never,
        edits: [],
        dropped: [],
        ...(apply !== undefined ? { apply } : {}),
      }).text.split('\n')

    expect(empty(INIT_CLOSING).at(-1)).toBe('0 files · nothing written')
    expect(empty(INIT_CLOSING).join('\n')).not.toContain('git apply')
    expect(empty().at(-1)).toBe('Nothing is provisioned yet. The merge is what authorises it.')
  })

  it('ends a preview whose Component was dropped on a negative answer, never exit 0', () => {
    // A document appended after an open quoted scalar is swallowed by it:
    // "nothing to change." at exit 0 would say the service is declared when
    // nothing declares it (#83). Unreachable through `runInitRepo` today — a
    // file like this one is refused before the model — so pinned here.
    const request = 'declare this repository in the catalogue'
    const signed = signPlan(
      planSchema.parse({ intent: request, operations: [COMPONENT] }),
      {
        witnessed: new Set(),
        vocabulary: { kinds: [], types: [], environments: [], owners: [] },
        repoRoot: '/service',
        declared: new Map(),
      },
      {
        intent: request,
        wordsOf: 'engine',
        answers: new Map([
          ['operations.0.entity.metadata.name', 'billing-api'],
          ['operations.0.entity.spec.type', 'service'],
          ['operations.0.entity.spec.lifecycle', 'production'],
          ['operations.0.entity.spec.owner', 'group:default/tiger'],
        ]),
      },
    )
    if ('outcome' in signed) throw new Error(JSON.stringify(signed.refusals))
    const kept = [{ path: 'catalog-info.yaml', text: 'description: "open\n' }]
    const result = previewOf(signed, request, kept, 'catalog-info.yaml', {})
    expect(result.text).toContain('the edit did not declare it')
    expect(result.found).toBe(false)
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

  it('does not let its own sentence vouch for a name the inspection never read', async () => {
    // F12. `requestOf` composes "declare this repository in the catalogue,
    // from what its own files state", and `signPlan` measures every value
    // against the intent — so a Component named `repository-files` signed
    // ECHOED, the claim that means "the person asked for it", on two words the
    // engine had written about itself.
    //
    // The inspection read `billing-api`. Anything else the Architect writes
    // into that field is now vouched for by nothing and becomes a question,
    // which is the guarantee this command has always claimed to make.
    const project = await application()
    const before = await hashTree(project)
    const client = drafting([
      {
        ...COMPONENT,
        entity: { ...COMPONENT.entity, metadata: { name: 'repository-files' } },
      },
    ])

    const result = await runInitRepo({ project, client, emit: () => {} })

    expect(result.text).toContain('metadata.name')
    expect(result.text).not.toContain('+++ b/catalog-info.yaml')
    expect(await hashTree(project)).toBe(before)
  })

  it('still writes the name the inspection did read', async () => {
    // The other half: what the project's own files state arrives as answers
    // at the fields it was read for, so the four values an inspection
    // establishes still stand behind themselves and the ordinary run is
    // unchanged.
    const project = await application()
    const client = drafting([COMPONENT])

    const result = await runInitRepo({ project, client, emit: () => {} })

    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text).toContain('billing-api')
  })

  it('vouches for a fact at the field it was read for, and nowhere else', async () => {
    // The inspection read `production` as the LIFECYCLE. A type of
    // `production` is a value the Architect put in a different field, and
    // nothing read it there: it is a question, not a fact that happens to
    // share its spelling with one.
    const project = await application()
    const before = await hashTree(project)
    const client = drafting([
      {
        ...COMPONENT,
        entity: { ...COMPONENT.entity, spec: { ...COMPONENT.entity.spec, type: 'production' } },
      },
    ])

    const result = await runInitRepo({ project, client, emit: () => {} })

    expect(result.unsupported).toBe(true)
    expect(result.text).toContain('operations.0.entity.spec.type')
    expect(result.text).not.toContain('operations.0.entity.spec.lifecycle')
    expect(result.text).not.toContain('+++ b/catalog-info.yaml')
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
    // Shown as the draft's, on the prompt's own line (#72), and nowhere else:
    // never as a value, and never in a catalog-info.
    expect(
      result.text.split('\n').filter((line) => line.includes('anything-the-model-likes')),
    ).toEqual(['      the draft says anything-the-model-likes'])
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

describe('init --submit', () => {
  const FLAGS = { iacRepo: 'github.com/acme/iac', environments: ['dev', 'staging', 'prod'] }

  // Every repository here is a real one, removed at the end: a small disk fills.
  const made: string[] = []
  afterAll(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** `application()`, remembered for removal. */
  const service = async (config?: string): Promise<string> => {
    const root = await application(config)
    made.push(root)
    return root
  }

  const clonedApplication = async (files: Record<string, string> = {}): Promise<string> => {
    const project = await service()
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true })
      await writeFile(path.join(project, file), text, 'utf8')
    }
    await committed(project)
    return project
  }

  const submitted = async (project: string): Promise<string> => {
    const [branch] = (await git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/idp-agent/')).split('\n')
    return branch ?? ''
  }

  it('cuts one branch in the application repository holding the catalog-info and the configuration', async () => {
    const project = await clonedApplication()
    const before = await observable(project)

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: FLAGS,
    })

    expect(result.found).toBe(true)
    expect(result.text).toMatch(/submitted as idp-agent\/init-billing-api-[0-9a-f]{8} on top of main@[0-9a-f]{7}/)
    const branch = await submitted(project)
    expect(await git(project, 'diff', '--name-only', 'main', branch)).toBe(`${CONFIG_FILE}\ncatalog-info.yaml`)
    expect(await show(project, branch, CONFIG_FILE)).toBe(serializeConfig(FLAGS))
    const added = (await observable(project)).split('\n').filter((line) => !before.split('\n').includes(line))
    expect(added).toHaveLength(1)
  })

  it('files in the root catalog-info.yml the service keeps, as the preview does', async () => {
    // #82: never a twin catalog-info.yaml beside it.
    const project = await clonedApplication({
      'catalog-info.yml':
        'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing\nspec:\n  type: openapi\n' +
        '  lifecycle: production\n  owner: group:default/tiger\n  definition: "{}"\n',
    })
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {} })
    expect(result.found).toBe(true)
    expect(await git(project, 'diff', '--name-only', 'main', await submitted(project))).toBe('catalog-info.yml')
  })

  it('files in the one catalog-info the service keeps in a folder', async () => {
    const project = await clonedApplication({ 'deploy/catalog-info.yaml': '# nothing declared yet\n' })
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {} })
    expect(result.found).toBe(true)
    expect(await git(project, 'diff', '--name-only', 'main', await submitted(project))).toBe('deploy/catalog-info.yaml')
  })

  it('refuses a service in a subfolder of its repository, not submitted by this build, before a model call', async () => {
    // D12: the forge cuts a branch at a clone's root; prefixed paths are a follow-up.
    const root = await clonedApplication({ 'services/billing/package.json': '{ "name": "billing-api" }\n' })
    const client = drafting([COMPONENT])
    const before = await observable(root)
    const refused = runInitRepo({ project: path.join(root, 'services', 'billing'), client, emit: () => {}, submit: {} })
    await expect(refused).rejects.toThrow(/not at its root/)
    await expect(refused).rejects.toThrow(/a service in a subfolder of its repository is not submitted by this build/)
    expect(client.seen).toEqual([])
    expect(await observable(root)).toBe(before)
  })

  it('writes the configuration readConfig reads back', async () => {
    const project = await clonedApplication()
    await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {}, flags: FLAGS })
    const checkout = await temp()
    made.push(checkout)
    await writeFile(path.join(checkout, CONFIG_FILE), await show(project, await submitted(project), CONFIG_FILE))
    expect(await readConfig(checkout)).toEqual(FLAGS)
  })

  it('asks for what the flags did not say, and exits 3, before a model call, when nobody can answer', async () => {
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    const result = await runInitRepo({
      project,
      client,
      emit: () => {},
      submit: {},
      flags: { iacRepo: 'github.com/acme/iac' },
    })
    expect(result.unsupported).toBe(true)
    expect(result.text).toContain(`${CONFIG_FILE}.environments`)
    expect(result.text).toContain('--environment')
    expect(result.text).not.toContain(`${CONFIG_FILE}.iacRepo`)
    expect(client.seen).toEqual([])
    expect(await git(project, 'for-each-ref', 'refs/heads/idp-agent/')).toBe('')
  })

  it('takes the answer a person gives, and nothing the inspection read', async () => {
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    let modelCallsWhenAsked = -1
    const result = await runInitRepo({
      project,
      client,
      emit: () => {},
      submit: {},
      flags: { iacRepo: 'github.com/acme/iac' },
      ask: async (question) => {
        if (!question.path.endsWith('.environments')) return undefined
        // A person's time is asked for before a model is paid for.
        modelCallsWhenAsked = client.seen.length
        return 'dev, prod'
      },
    })
    expect(result.found).toBe(true)
    expect(modelCallsWhenAsked).toBe(0)
    expect(await show(project, await submitted(project), CONFIG_FILE)).toContain('environments: ["dev", "prod"]')
  })

  it('refuses an answer holding a bidi control, as a refused answer, before a model call', async () => {
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    const result = await runInitRepo({
      project,
      client,
      emit: () => {},
      submit: {},
      flags: { iacRepo: 'github.com/acme/iac' },
      ask: async () => 'dev, prod\u2066',
    })
    expect(result.found).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('the answer was refused')
    expect(result.text).not.toContain('\u2066')
    expect(client.seen).toEqual([])
  })

  it('refuses an answer that spells a format character, spelled out, before a model call', async () => {
    // U+200B is refused like a bidi control, and must be as visible in the refusal.
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    const result = await runInitRepo({
      project,
      client,
      emit: () => {},
      submit: {},
      flags: { iacRepo: 'github.com/acme/iac' },
      ask: async () => 'dev,\u200bprod',
    })
    expect(result.found).toBe(false)
    expect(result.text).toContain('dev,\\u200bprod')
    expect(result.text).not.toContain('\u200b')
    expect(client.seen).toEqual([])
  })

  it('refuses a locator answer that carries a credential, never quoting it, before a model call', async () => {
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    const before = await observable(project)
    const result = await runInitRepo({
      project,
      client,
      emit: () => {},
      submit: {},
      flags: { environments: ['dev'] },
      ask: async () => 'https://x-access-token:ghp_SECRET123@github.com/acme/iac',
    })
    expect(result.found).toBe(false)
    expect(result.unsupported).toBeUndefined()
    expect(result.text).toContain('the answer was refused')
    expect(result.text).toContain('userinfo, a query or a fragment')
    expect(result.text).not.toContain('SECRET')
    expect(client.seen).toEqual([])
    expect(await observable(project)).toBe(before)
  })

  it('says the configuration a flag asked for is not written when the service is already declared', async () => {
    // Adaptation 5: the configuration rides on the Component's branch, and
    // there is no Component to add. Said, never a typed flag dropped in silence.
    const declared =
      'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\nspec:\n' +
      '  type: service\n  lifecycle: production\n  owner: group:default/tiger\n'
    for (const submit of [undefined, {}] as const) {
      const project = await clonedApplication({ 'catalog-info.yaml': declared })
      const result = await runInitRepo({
        project,
        client: drafting([COMPONENT]),
        emit: () => {},
        flags: FLAGS,
        ...(submit !== undefined ? { submit } : {}),
      })
      expect(result.found).toBe(true)
      expect(result.text).toContain('catalog-info.yaml already declares component:default/billing-api')
      expect(result.text).toContain(`${CONFIG_FILE} is not written either`)
      expect(result.text).toMatch(/0 files · nothing written$/)
      expect(await git(project, 'for-each-ref', 'refs/heads/idp-agent/')).toBe('')
    }
  })

  it('never rewrites a committed configuration that says something else, and says so before a model call', async () => {
    const project = await service('iacRepo: github.com/other/iac\nenvironments: [prod]\n')
    await committed(project)
    const before = await observable(project)
    const client = drafting([COMPONENT])

    const result = await runInitRepo({ project, client, emit: () => {}, submit: {}, flags: FLAGS })

    expect(result.found).toBe(false)
    expect(result.text).toContain(CONFIG_FILE)
    expect(client.seen).toEqual([])
    expect(await observable(project)).toBe(before)
  })

  it('leaves a committed configuration alone when the flags say the same, however it is written', async () => {
    // Unquoted, as a person writes it; `serializeConfig` quotes. Compared by value.
    const project = await service('iacRepo: github.com/acme/iac\nenvironments: [dev, staging, prod]\n')
    await committed(project)

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      submit: {},
      flags: FLAGS,
    })

    expect(result.found).toBe(true)
    expect(await git(project, 'diff', '--name-only', 'main', await submitted(project))).toBe('catalog-info.yaml')
  })

  it('refuses flags the schema refuses before a single model call', async () => {
    const project = await clonedApplication()
    const client = drafting([COMPONENT])
    await expect(
      runInitRepo({ project, client, emit: () => {}, submit: {}, flags: { iacRepo: '', environments: ['dev'] } }),
    ).rejects.toThrow(ConfigError)
    expect(client.seen).toEqual([])
  })

  it('refuses a working tree that is not HEAD before a single model call', async () => {
    const project = await clonedApplication({ 'catalog-info.yaml': '# committed\n' })
    await writeFile(path.join(project, 'catalog-info.yaml'), '# changed, not committed\n', 'utf8')
    const client = drafting([COMPONENT])
    const before = await observable(project)
    const result = await runInitRepo({ project, client, emit: () => {}, submit: {} })
    expect(result.found).toBe(false)
    expect(result.text).toContain('catalog-info.yaml')
    expect(result.text).not.toContain('+++ b/')
    expect(client.seen).toEqual([])
    expect(await observable(project)).toBe(before)
  })

  it('refuses an uncommitted configuration it would have to vouch for, before a model call', async () => {
    const project = await clonedApplication()
    await writeFile(path.join(project, CONFIG_FILE), 'iacRepo: github.com/acme/iac\nenvironments: [dev]\n', 'utf8')
    const client = drafting([COMPONENT])
    const result = await runInitRepo({ project, client, emit: () => {}, submit: {} })
    expect(result.found).toBe(false)
    expect(result.text).toContain(CONFIG_FILE)
    expect(client.seen).toEqual([])
  })

  it('answers a second submission before the confirmation, and writes nothing', async () => {
    // The owner's addition of 2026-09-29, on init's road: the questions that
    // decide the bytes are still asked, the [y/N] is not.
    const project = await clonedApplication()
    await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, submit: {}, flags: FLAGS })
    const [seen, objects] = [await observable(project), await stored(project)]
    let prompted = false

    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      flags: FLAGS,
      submit: {
        confirm: async () => {
          prompted = true
          return true
        },
      },
    })

    expect(result.found).toBe(true)
    expect(prompted).toBe(false)
    expect(result.text).toMatch(/^2 files · already submitted as idp-agent\/init-billing-api-[0-9a-f]{8} · nothing written$/m)
    expect(await observable(project)).toBe(seen)
    expect(await stored(project)).toBe(objects)
  })

  it('shows the diff at the prompt, then submits, for the service repository', async () => {
    const project = await clonedApplication()
    const shown: { repository: string; files: readonly { path: string }[] }[] = []
    const result = await runInitRepo({
      project,
      client: drafting([COMPONENT]),
      emit: () => {},
      flags: FLAGS,
      submit: {
        confirm: async (summary) => {
          shown.push(summary)
          return true
        },
      },
    })
    expect(result.found).toBe(true)
    expect(shown).toHaveLength(1)
    expect(shown[0]?.repository).toBe('service')
    expect(shown[0]?.files.map((file) => file.path)).toEqual([CONFIG_FILE, 'catalog-info.yaml'])
    expect(result.text).not.toContain('+++ b/')
  })

  it('prints what it prints today without --submit or a flag, APPLY included', async () => {
    const project = await clonedApplication()
    const before = await hashTree(project)
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {} })
    expect(result.text.trimEnd().endsWith('then git apply catalog-info.diff')).toBe(true)
    expect(result.text).not.toContain(CONFIG_FILE)
    expect(await hashTree(project)).toBe(before)
  })

  it('previews the configuration a flag states without --submit, and writes nothing', async () => {
    const project = await clonedApplication()
    const before = await hashTree(project)
    const result = await runInitRepo({ project, client: drafting([COMPONENT]), emit: () => {}, flags: FLAGS })
    expect(result.found).toBe(true)
    expect(result.text).toContain(`+++ b/${CONFIG_FILE}`)
    expect(result.text).toContain('+++ b/catalog-info.yaml')
    expect(result.text.trimEnd().endsWith('then git apply catalog-info.diff')).toBe(true)
    expect(await hashTree(project)).toBe(before)
  })
})

describe('init --submit through main', () => {
  const made: string[] = []
  afterAll(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const run = async (args: string[], client?: LlmClient, gh?: GhProcess) => {
    const io = capture()
    const cwd = await temp()
    made.push(cwd)
    const code = await main(args, {
      cwd,
      out: (chunk) => void io.out.push(chunk),
      err: (chunk) => void io.err.push(chunk),
      ...(client !== undefined ? { client } : {}),
      ...(gh !== undefined ? { gh } : {}),
    })
    return { code, out: io.out.join(''), err: io.err.join('') }
  }

  /** A committed service whose `main` tracks a branch on github.com, and a gh nobody may start. */
  const onGitHub = async (): Promise<{ readonly root: string; readonly gh: GhProcess; readonly calls: () => number }> => {
    const root = await application()
    made.push(root)
    await committed(root)
    await git(root, 'remote', 'add', 'origin', 'git@github.com:acme/billing-api.git')
    await git(root, 'config', 'branch.main.remote', 'origin')
    await git(root, 'config', 'branch.main.merge', 'refs/heads/main')
    let calls = 0
    const gh: GhProcess = async () => {
      calls += 1
      throw new Error('gh was started')
    }
    return { root, gh, calls: () => calls }
  }

  it("cuts init's branch with --local, and says nothing was pushed", async () => {
    const { root, gh, calls } = await onGitHub()
    const { code, out } = await run(['init', '--repo', root, '--submit', '--local'], drafting([COMPONENT]), gh)
    expect(code).toBe(0)
    expect(out).toMatch(/1 file · submitted as idp-agent\/init-billing-api-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched/)
    expect(out).toContain('--local: nothing pushed by this run')
    expect(calls()).toBe(0)
  })

  it('refuses a directory that is not a clone as an argument, before a model is even configured', async () => {
    const project = await application()
    made.push(project)
    const { code, err } = await run(['init', '--repo', project, '--submit'])
    expect(code).toBe(2)
    expect(err).toContain('not a git working tree')
    expect(err).not.toContain('no model configured')
  })

  it('refuses a service in a subfolder of its repository with exit 2, before a model call (D12)', async () => {
    const root = await application()
    made.push(root)
    await mkdir(path.join(root, 'services', 'billing'), { recursive: true })
    await writeFile(path.join(root, 'services', 'billing', 'package.json'), '{ "name": "billing-api" }\n')
    await committed(root)
    const client = drafting([COMPONENT])
    const { code, err } = await run(['init', '--repo', path.join(root, 'services', 'billing'), '--submit'], client)
    expect(code).toBe(2)
    expect(err).toContain('not submitted by this build')
    expect(client.seen).toEqual([])
  })

  it('refuses an --environment holding a bidi control, naming the flag, exit 2, with no model call', async () => {
    const root = await application()
    made.push(root)
    await committed(root)
    const client = drafting([COMPONENT])
    const { code, err } = await run(
      ['init', '--repo', root, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', 'prod\u2066'],
      client,
    )
    expect(code).toBe(2)
    expect(err).toContain('--environment')
    expect(err).not.toContain('\u2066')
    expect(client.seen).toEqual([])
  })

  it('refuses flags the configuration schema refuses with exit 2, with no model call', async () => {
    const root = await application()
    made.push(root)
    await committed(root)
    const client = drafting([COMPONENT])
    const long = 'x'.repeat(64)
    const { code, err } = await run(
      ['init', '--repo', root, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', long],
      client,
    )
    expect(code).toBe(2)
    expect(err).toContain(CONFIG_FILE)
    expect(client.seen).toEqual([])
  })

  it('submits through main, and the second run names the branch it already cut', async () => {
    const root = await application()
    made.push(root)
    await committed(root)
    const args = ['init', '--repo', root, '--submit', '--iac-repo', 'github.com/acme/iac', '--environment', 'dev', '--environment', 'prod']
    const first = await run(args, drafting([COMPONENT]))
    expect(first.code).toBe(0)
    expect(first.out).toMatch(/2 files · submitted as idp-agent\/init-billing-api-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched/)
    const second = await run(args, drafting([COMPONENT]))
    expect(second.code).toBe(0)
    expect(second.out).toMatch(/2 files · already submitted as idp-agent\/init-billing-api-[0-9a-f]{8} · nothing written/)
  })
})

/**
 * `init --submit` to GitHub (stage 6 plan, 6.3.2): the service's own clone,
 * its `main` tracking `git@github.com:acme/billing-api.git`, a bare repository
 * standing for GitHub's side, the fake ssh that serves it, and the fake gh
 * handed in as `MainDeps.gh`, `main` protected as `docs/submitting.md` says.
 * The service's repository passes the configuration check and the preflight
 * the declarations repository does (decision 17); its `.idp-agent.yml` names
 * the declarations repository, which is another, so no `iacRepo` is held to
 * the clone.
 */
describe('init --submit to GitHub', { timeout: 30_000 }, () => {
  const FLAGS = ['--iac-repo', 'github.com/acme/iac', '--environment', 'dev', '--environment', 'prod']
  const made: string[] = []
  afterAll(async () => {
    await removeClones()
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** A service committed on main, its remote git@github.com:acme/billing-api.git, level with GitHub. */
  const service = async () => {
    const source = await application()
    made.push(source)
    return githubClone({ source, repository: 'acme/billing-api' })
  }

  const run = async (
    clone: Awaited<ReturnType<typeof githubClone>>,
    args: string[],
    deps: Parameters<typeof main>[1] = {},
  ) => {
    const io = capture()
    const code = await main(['init', '--repo', clone.repo, '--submit', ...FLAGS, ...args], {
      cwd: clone.repo,
      env: clone.env,
      gh: clone.gh.process,
      ...deps,
      out: (chunk) => void io.out.push(chunk),
      err: (chunk) => void io.err.push(chunk),
    })
    return { code, out: io.out.join(''), err: io.err.join('') }
  }

  const ours = async (dir: string): Promise<string[]> =>
    (await git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/idp-agent/')).split('\n').filter((line) => line !== '')

  it('opens a pull request on the service’s own repository, holding the catalog-info and the configuration', async () => {
    const clone = await service()

    const { code, out, err } = await run(clone, [], { client: drafting([COMPONENT]) })

    expect(code, err).toBe(0)
    expect(err).toMatch(/^submitting to github\.com\/acme\/billing-api, into main \(origin, main's upstream\), as [A-Za-z0-9-]+ \(gh\)$/m)
    expect(out).toMatch(/^2 files · submitted as idp-agent\/init-billing-api-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched$/m)
    expect(out).toContain('Pull request #1 opened on github.com/acme/billing-api: https://github.com/acme/billing-api/pull/1')
    const [ref] = await ours(clone.bare)
    expect(await git(clone.bare, 'diff', '--name-only', 'main', ref ?? '')).toBe(`${CONFIG_FILE}\ncatalog-info.yaml`)

    // What the reviewer reads on GitHub: a model drafted the catalog-info, and
    // the body says so rather than crediting a person with it (D4).
    const posted = clone.gh.sent.filter(({ argv }) => argv.includes('POST'))
    expect(posted).toHaveLength(1)
    const { body } = JSON.parse(posted[0]?.stdin?.toString('utf8') ?? '{}') as { body?: string }
    expect(body).toContain(
      "This change was drafted by a model from the service's own files and written by idpa init in its own repository: " +
        'two gates, the schema and the signature, every value the model chose either read by the inspection ' +
        'or typed by a person, and no Reviewer.',
    )
    expect(body).not.toContain('from what a person typed')
  })

  it('holds no iacRepo to the repository it submits to: the service names the declarations repository, which is another', async () => {
    // § 13's cross-check is the intent road's: there, the clone IS the repository iacRepo
    // names. Here the branch goes to the service, and iacRepo names somewhere else by design.
    const clone = await service()
    const { code } = await run(clone, [], { client: drafting([COMPONENT]) })
    expect(code).toBe(0)
  })

  it('names the open pull request on a second run, not asked, and writes nothing', async () => {
    const clone = await service()
    await run(clone, [], { client: drafting([COMPONENT]) })
    const before = await observable(clone.repo)
    let asked = 0

    const { code, out } = await run(clone, [], {
      client: drafting([COMPONENT]),
      confirm: async () => {
        asked += 1
        return true
      },
    })

    expect(code).toBe(0)
    expect(out).toMatch(/2 files · already submitted as idp-agent\/init-billing-api-[0-9a-f]{8} · pull request #1 is open · nothing written/)
    expect(asked).toBe(0)
    expect(await observable(clone.repo)).toBe(before)
  })

  it('says the note before the Inspector, and opens the service’s pull request', async () => {
    const clone = await service()
    unprotect(clone.gh)
    const inner = drafting([COMPONENT])
    const said: string[] = []
    const client: LlmClient = {
      generate: async (request) => {
        said.push(`model ${request.agent}`)
        return inner.generate(request)
      },
    }
    const out: string[] = []

    const code = await main(['init', '--repo', clone.repo, '--submit', ...FLAGS], {
      cwd: clone.repo,
      env: clone.env,
      gh: clone.gh.process,
      client,
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void said.push(`err ${chunk}`),
    })

    expect(code, said.join('')).toBe(0)
    const noted = said.indexOf(`err ${MERGE_NOTE}\n`)
    expect(noted).toBeGreaterThan(-1)
    expect(said.filter((line) => line === `err ${MERGE_NOTE}\n`)).toHaveLength(1)
    expect(noted).toBeLessThan(said.findIndex((line) => line.startsWith('model ')))
    expect(out.join('')).not.toContain('Add a ruleset')
    expect(out.join('')).not.toContain(MERGE_NOTE)
    expect(out.join('')).toContain('Pull request #1 opened on github.com/acme/billing-api: https://github.com/acme/billing-api/pull/1')
    expect(clone.gh.state.pulls?.[0]?.body.split('\n')).toContain(MERGE_NOTE)
    expect(await ours(clone.bare)).toHaveLength(1)
  })

  it('refuses a service repository gh’s account cannot push to, before the Inspector, naming --local', async () => {
    const clone = await service()
    clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
      ...one,
      permissions: { ada: { admin: false, maintain: false, push: false } },
    }))
    const client = drafting([COMPONENT])

    const { code, out } = await run(clone, [], { client })

    expect(code).toBe(1)
    expect(out.trimEnd().split('\n')).toEqual([
      'not submitted — github.com/acme/billing-api cannot take a pull request from this run:',
      "  missing: push access: gh's account cannot push to acme/billing-api",
      'Then run this again, or add --local to cut the branch in this clone only. Nothing was written.',
    ])
    expect(client.seen).toEqual([])
    expect(await ours(clone.repo)).toEqual([])
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a service clone that is not level with GitHub, exit 1, before the Inspector', async () => {
    const clone = await service()
    await moveGitHubBase(clone)
    const client = drafting([COMPONENT])
    const { code, out } = await run(clone, [], { client })
    expect(code).toBe(1)
    expect(out).toContain('bring them level (git pull)')
    expect(client.seen).toEqual([])
  })

  it('refuses gh logged out, exit 2, before the model is configured, and --local cuts the branch in the clone only', async () => {
    const clone = await service()
    clone.gh.logout()

    const refused = await run(clone, [])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('gh is not logged in to github.com')
    expect(refused.err).not.toContain('no model configured')

    const local = await run(clone, ['--local'], { client: drafting([COMPONENT]) })
    expect(local.code).toBe(0)
    expect(local.out).toContain('--local: nothing pushed by this run')
    expect(await ours(clone.repo)).toHaveLength(1)
    expect(await ours(clone.bare)).toEqual([])
  })

  it('refuses a key of the service clone’s own configuration, exit 2, naming it and its scope, never its value', async () => {
    // A rewrite that does not match origin's URL: one that did would put the
    // clone on another host's road, where nothing is pushed and nothing judged
    // (road.test.ts). This one is refused for what it could do to a push.
    const clone = await service()
    await git(clone.repo, 'config', 'url.ssh://mirror.canary.example/.insteadOf', 'git@nowhere.example:')
    const client = drafting([COMPONENT])

    const { code, out, err } = await run(clone, [], { client })

    expect(code).toBe(2)
    expect(err).toContain('url.ssh://mirror.canary.example/.insteadof (local), which would decide where your push goes')
    for (const text of [out, err]) expect(text).not.toContain('nowhere.example')
    expect(err).not.toContain('no model configured')
    expect(client.seen).toEqual([])
  })

  it('opens the pull request with the note when the rules go while the Architect drafts', async () => {
    const clone = await service()
    const inner = drafting([COMPONENT])
    const client: LlmClient = {
      generate: async (request) => {
        if (request.agent === 'architect') unprotect(clone.gh)
        return inner.generate(request)
      },
    }

    const { code, out, err } = await run(clone, [], { client })

    expect(code, err).toBe(0)
    // The preflight found the rules whole; step 11's read found them gone, and the run says so once.
    expect(err.split('\n').filter((line) => line === MERGE_NOTE)).toHaveLength(1)
    expect(out).toContain('Pull request #1 opened on github.com/acme/billing-api')
    expect(clone.gh.state.pulls?.[0]?.body.split('\n')).toContain(MERGE_NOTE)
    const [ref] = await ours(clone.repo)
    expect(await ours(clone.bare)).toEqual([ref])
  })

  it('asks the question of § 3, naming the service’s repository', async () => {
    const clone = await service()
    const summaries: SubmissionSummary[] = []
    await run(clone, [], {
      client: drafting([COMPONENT]),
      confirm: async (summary) => {
        summaries.push(summary)
        return false
      },
    })
    expect(summaries[0]?.github).toStrictEqual({ host: 'github.com', repository: 'acme/billing-api', base: 'main', pushedAlready: false, authorMayMergeAlone: false })
  })

  /** The service, with grace beside ada, both able to push: another person's run is hers. */
  const shared = async () => {
    const clone = await service()
    clone.gh.state.accounts = [...clone.gh.state.accounts, { login: 'grace', type: 'User' }]
    clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
      ...one,
      permissions: { ...one.permissions, grace: { admin: false, maintain: false, push: true } },
    }))
    return clone
  }

  it('says a pull request in flight on the service’s catalog-info before the Inspector, goes on, and opens beside it', async () => {
    const clone = await shared()
    await pullRequestBy(clone, { login: 'grace', edits: { 'catalog-info.yml': 'kind: Component\n' } })
    const theirs = clone.gh.state.pulls?.[0]?.head ?? ''
    const inner = drafting([COMPONENT])
    const said: string[] = []
    const client: LlmClient = {
      generate: async (request) => {
        said.push(`model ${request.agent}`)
        return inner.generate(request)
      },
    }

    const output: string[] = []
    const code = await main(['init', '--repo', clone.repo, '--submit', ...FLAGS], {
      cwd: clone.repo,
      env: clone.env,
      gh: clone.gh.process,
      client,
      out: (chunk) => void output.push(chunk),
      err: (chunk) => void said.push(`err ${chunk}`),
    })
    const out = output.join('')

    expect(code, said.join('')).toBe(0)
    const flight = said.indexOf(
      `err in flight on github.com/acme/billing-api, touching the service's catalog-info: pull request #1 by grace (${theirs}), changing catalog-info.yml\n`,
    )
    expect(flight, said.join('')).toBeGreaterThan(-1)
    expect(said[flight + 1]).toBe('err this run drafts the change, then compares it with them before anything is written\n')
    expect(flight).toBeLessThan(said.findIndex((line) => line.startsWith('model ')))
    expect(out).toContain('Pull request #2 opened on github.com/acme/billing-api')
    expect(out).toContain('In flight beside it on github.com/acme/billing-api: pull request #1, changing catalog-info.yml')
    expect(out).not.toContain('grace')
    expect(clone.gh.state.pulls?.find((one) => one.number === 2)?.body).toContain(
      'Opened beside pull request 1, open into `main`, which change other files of the same entities.',
    )
  })

  it('refuses after the Architect a pull request in flight that changes catalog-info.yaml differently, naming --local, exit 1', async () => {
    const clone = await shared()
    await pullRequestBy(clone, { login: 'grace', edits: { 'catalog-info.yaml': 'kind: Component\n' } })
    const client = drafting([COMPONENT])
    const before = await observable(clone.repo)

    const { code, out, err } = await run(clone, [], { client })

    expect(code).toBe(1)
    expect(client.seen.length).toBeGreaterThan(0)
    expect(out).toContain(
      '  pull request #1 on github.com/acme/billing-api already changes catalog-info.yaml, differently: https://github.com/acme/billing-api/pull/1',
    )
    expect(out).toContain(
      'Review it there, or run this again once it is merged or closed, or add --local to cut the branch in this clone only. Nothing was written.',
    )
    expect(err).toContain('In pull request #1, catalog-info.yaml:')
    expect(out).not.toContain('grace')
    expect(await observable(clone.repo)).toBe(before)
    expect(clone.gh.state.pulls).toHaveLength(1)
  })

  it('names the same catalog-info already proposed, exit 0', async () => {
    const clone = await shared()
    clone.gh.as('grace')
    expect((await run(clone, [], { client: drafting([COMPONENT]) })).code).toBe(0)
    clone.gh.as('ada')
    await git(clone.repo, 'update-ref', '-d', (await ours(clone.repo))[0] ?? '')
    const before = await observable(clone.repo)

    const { code, out, err } = await run(clone, [], { client: drafting([COMPONENT]) })

    expect(code, err).toBe(0)
    expect(err.split('\n')).toContain('already proposed by grace in pull request #1')
    expect(out).toContain('already proposed in pull request #1 on github.com/acme/billing-api: https://github.com/acme/billing-api/pull/1 · nothing written')
    expect(out).not.toContain('grace')
    expect(await observable(clone.repo)).toBe(before)
  })

  it('refuses before the Inspector a read that cannot be made whole', async () => {
    const clone = await shared()
    clone.gh.state.pulls = Array.from({ length: 21 }, (_, at) => ({
      number: at + 1,
      owner: 'acme',
      name: 'billing-api',
      title: 't',
      body: '',
      head: `idp-agent/theirs-${String(at).padStart(8, '0')}`,
      base: 'main',
      draft: false,
      maintainer_can_modify: false,
      author: 'grace',
      state: 'open' as const,
      merged_at: null,
      closed_at: null,
      lastPusher: 'grace',
      reviews: [],
      headSha: String(at + 1).padStart(40, 'a'),
      files: [],
    }))
    const client = drafting([COMPONENT])

    const { code, out } = await run(clone, [], { client })

    expect(code).toBe(1)
    expect(out.trimEnd()).toBe(
      'github.com/acme/billing-api has 21 open idp-agent pull requests into main, more than the 20 this build compares: ' +
        'review some of them, then run this again. Nothing was written.',
    )
    expect(client.seen).toEqual([])
  })

  it('still refuses a service in a subfolder of its repository (D12), exit 2, before gh is started', async () => {
    const root = await application()
    made.push(root)
    await mkdir(path.join(root, 'services', 'billing'), { recursive: true })
    await writeFile(path.join(root, 'services', 'billing', 'package.json'), '{ "name": "billing-api" }\n')
    const clone = await githubClone({ source: root, repository: 'acme/billing-api' })
    const calls: string[] = []
    const gh: GhProcess = async (argv, options) => {
      calls.push(argv.join(' '))
      return clone.gh.process(argv, options)
    }

    const io = capture()
    const code = await main(['init', '--repo', path.join(clone.repo, 'services', 'billing'), '--submit', ...FLAGS], {
      env: clone.env,
      gh,
      out: (chunk) => void io.out.push(chunk),
      err: (chunk) => void io.err.push(chunk),
    })

    expect(code).toBe(2)
    expect(io.err.join('')).toContain('a service in a subfolder of its repository is not submitted by this build')
    expect(calls).toEqual([])
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

    const { edits } = catalogInfoEdits(
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

describe('a catalog-info.yaml written with CRLF line endings', () => {
  it('is seen to declare the component already, and is left as it was', () => {
    // Blind to `\r\n`, `listDocumentNames` found no document in a file saved on
    // Windows, and `init` proposed a second declaration of the same name —
    // the silent duplicate of design 4.4.
    const text = [
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
    ].join('\r\n')
    const { edits } = catalogInfoEdits(
      {
        intent: 'declare this service',
        operations: [
          {
            op: 'create-catalog-info',
            repoPath: 'catalog-info.yaml',
            entity: {
              kind: 'Component',
              metadata: { name: 'billing-api' },
              spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
            },
          },
        ],
      } as never,
      { files: [{ path: 'catalog-info.yaml', text }] },
    )
    expect(edits).toEqual([{ path: 'catalog-info.yaml', before: text, after: text }])
  })
})
