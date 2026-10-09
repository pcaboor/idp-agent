import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  HELP,
  InterruptedError,
  main,
  parseArguments,
  promptOnTerminal,
  type MainDeps,
} from '../../src/cli/index.js'
import { initRoot } from '../../src/cli/repository.js'
import { VERSION } from '../../src/core/index.js'
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'

/**
 * The edges of the command line (review, batch A1): what `-h`, `--version` and
 * `<command> --help` do, which directories `validate` and `init` refuse before
 * any model is chosen, and what Ctrl-C at a question exits with. Each refusal
 * here is exit 2 and reaches no model — the scripted client below records every
 * request it is sent, and `env: {}` configures none, so a run that got as far
 * as choosing one would say "no model configured" instead.
 */

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-edges-'))

/** A client that answers nothing, and remembers whether anything asked it. */
const silent = (): LlmClient & { seen: GenerateRequest[] } => {
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request): Promise<GenerateResult> => {
      seen.push(request)
      return { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

const run = async (argv: string[], deps: MainDeps = {}) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    env: {},
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    ...deps,
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** HELP's line for a command, as the usage printed for it must carry it. */
const usageLine = (start: string): string => {
  const line = HELP.split('\n').find((candidate) => candidate.startsWith(`  ${start}`))
  if (line === undefined) throw new Error(`HELP has no line for ${start}`)
  return line
}

describe('-h, --version and version', () => {
  it.each([['-h'], ['--help'], ['help'], []])('%j prints the help, exit 0', async (...argv) => {
    const { code, out, err } = await run(argv)
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(out).toBe(HELP)
  })

  it.each([['--version'], ['-v'], ['version']])('%s prints the version, exit 0, and no model', async (flag) => {
    const client = silent()
    const { code, out, err } = await run([flag], { client })
    expect({ code, out, err }).toEqual({ code: 0, out: `${VERSION}\n`, err: '' })
    expect(client.seen).toEqual([])
  })

  it('is a command, never the start of a phrase, and takes nothing after it', () => {
    expect(COMMANDS).toContain('version')
    expect(parseArguments(['version'])).toStrictEqual({ name: 'version' })
    expect(parseArguments(['version', 'of', 'billing-api'])).toMatchObject({
      name: 'error',
      message: expect.stringContaining('version takes no argument'),
    })
  })

  it.each([['--version'], ['-v']])('%s takes nothing after it either, as version does', (flag) => {
    expect(parseArguments([flag, 'billing-api'])).toMatchObject({
      name: 'error',
      message: expect.stringContaining(`${flag} takes no argument`),
    })
  })

  it('answers a refused --version with the usage of version', async () => {
    const { code, err } = await run(['--version', 'billing-api'])
    expect(code).toBe(2)
    expect(err).toContain(usageLine('idp-agent version'))
    expect(err).not.toContain(usageLine('idp-agent graph '))
  })

  it('still suggests the command a slip is nearest to, now that two begin with a v', () => {
    expect(parseArguments(['valdiate'])).toMatchObject({ message: expect.stringContaining('did you mean validate?') })
    expect(parseArguments(['verison'])).toMatchObject({ message: expect.stringContaining('did you mean version?') })
  })
})

describe('<command> --help', () => {
  it.each([
    [['graph', '--help'], 'idp-agent graph '],
    [['show', '--help'], 'idp-agent show '],
    [['relations', '-h'], 'idp-agent relations '],
    [['ask', '--help'], 'idp-agent ask '],
    [['validate', '--help'], 'idp-agent validate '],
    [['plan', '--help'], 'idp-agent plan "'],
    [['plan', 'declare a database', '-h'], 'idp-agent plan --from'],
    [['init', '--help'], 'idp-agent init ['],
    [['init', 'platform', '--help'], 'idp-agent init platform'],
    [['version', '--help'], 'idp-agent version'],
    [['which databases?', '--help'], 'idpa "<phrase>"'],
  ])('%j prints that usage on stdout, exit 0, and no model', async (argv, start) => {
    const client = silent()
    const { code, out, err } = await run(argv, { client })
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(out).toContain(usageLine(start))
    expect(client.seen).toEqual([])
  })

  it('prints one command, not every other', async () => {
    const { out } = await run(['show', '--help'])
    expect(out).not.toContain(usageLine('idp-agent graph '))
    expect(out).toContain('idpa --help')
  })

  it('reads a --help after -- as words, as parseArgs does', () => {
    expect(parseArguments(['ask', '--', '--help'])).toStrictEqual({ name: 'ask', intent: '--help' })
  })

  it('answers a refused argument with the usage of its command, not the whole help', async () => {
    const { code, err } = await run(['show'])
    expect(code).toBe(2)
    expect(err).toContain('show needs a name or a reference')
    expect(err).toContain(usageLine('idp-agent show '))
    expect(err).not.toContain(usageLine('idp-agent graph '))
  })
})

describe('validate <directory>', () => {
  it.each([
    ['/nonexistent/idp-validate', '/nonexistent/idp-validate is not a directory'],
    ['', 'validate needs a directory, and "" names none'],
  ])('refuses %j, exit 2', async (directory, said) => {
    const { code, out, err } = await run(['validate', directory])
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain(said)
  })

  it('refuses a file, exit 2', async () => {
    const file = path.join(await temp(), 'catalog-info.yaml')
    await writeFile(file, 'kind: Component\n')
    const { code, out, err } = await run(['validate', file])
    expect({ code, out }).toEqual({ code: 2, out: '' })
    expect(err).toContain(`${file} is not a directory; validate names the declarations repository`)
  })

  it('refuses a second directory and an option it does not know, rather than ignoring either', async () => {
    const root = await temp()
    expect((await run(['validate', root, root])).code).toBe(2)
    expect(await run(['validate', root, root])).toMatchObject({ err: expect.stringContaining('one directory, not 2') })
    expect((await run(['validate', '--wat'])).code).toBe(2)
  })

  it('resolves a relative directory from where it is typed', async () => {
    // One entity, so the count tells the two apart: resolved from the process's
    // own directory, `IaC` is not there, and nothing would be read.
    const root = await temp()
    await mkdir(path.join(root, 'IaC/catalog/databases'), { recursive: true })
    await writeFile(path.join(root, 'IaC/catalog/databases/.witness.yml'), '# Declares nothing.\n')
    await writeFile(
      path.join(root, 'IaC/catalog/databases/a.yml'),
      '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: a\n' +
        'spec:\n  type: database\n  owner: group:default/tiger\n',
    )
    const { code, out } = await run(['validate', 'IaC'], { cwd: root })
    expect({ code, out }).toEqual({ code: 0, out: '1 entities in 1 files, 0 violations\n' })
  })

  it.skipIf(process.getuid?.() === 0)('reports a folder it could not list as an error, not as nothing', async () => {
    // A folder under chmod 000 lost every entity in it, and the run said
    // "0 violations" on exit 0: the one command CI trusts said compliant about
    // what it never read.
    const root = await temp()
    const locked = path.join(root, 'catalog/databases')
    await mkdir(locked, { recursive: true })
    await writeFile(path.join(locked, '.witness.yml'), '# Declares nothing.\n')
    await chmod(locked, 0o000)
    try {
      const { code, out } = await run(['validate', root])
      expect(code).toBe(1)
      expect(out).toMatch(/^error {3}catalog\/databases: could not be listed \(EACCES\); nothing in it was checked$/m)
      expect(out).toContain('1 violations')
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('reports a source-file annotation that leaves the repository, rather than passing over it', async () => {
    const root = await temp()
    await mkdir(path.join(root, 'catalog/databases'), { recursive: true })
    await writeFile(path.join(root, 'catalog/databases/.witness.yml'), '# Declares nothing.\n')
    await writeFile(
      path.join(root, 'catalog/databases/a.yml'),
      '---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: a\n' +
        '  annotations:\n    idp-agent.dev/source-file: ../../outside.yml\n' +
        'spec:\n  type: database\n  owner: group:default/tiger\n',
    )
    const { code, out } = await run(['validate', root])
    expect(code).toBe(1)
    expect(out).toContain('error   catalog/databases/a.yml: resource:default/a path escapes the repository: "../../outside.yml"')
  })
})

describe('init platform <directory>', () => {
  it('refuses an empty directory rather than scaffolding the one it runs in', async () => {
    const cwd = await temp()
    const { code, out, err } = await run(['init', 'platform', '', '--owner', '@acme/platform'], { cwd })
    expect({ code, out }).toEqual({ code: 2, out: '' })
    expect(err).toContain('init platform needs a directory, and "" names none')
  })

  it('refuses a second directory rather than ignoring it', async () => {
    const cwd = await temp()
    const { code, err } = await run(['init', 'platform', 'a', 'b', '--owner', '@acme/platform'], { cwd })
    expect(code).toBe(2)
    expect(err).toContain('init platform takes one directory, not 2: a, b')
  })
})

describe('init --project <directory>', () => {
  it.each([
    ['/nonexistent/idp-init', '/nonexistent/idp-init is not a directory; init --project names the application repository'],
    ['', '--project is empty; init --project names the application repository'],
  ])('refuses %j on exit 2 before a model is chosen', async (repo, said) => {
    const client = silent()
    const { code, out, err } = await run(['init', '--project', repo], { client, cwd: await temp() })
    expect({ code, out }).toEqual({ code: 2, out: '' })
    expect(err).toContain(said)
    expect(err).not.toContain('no model configured')
    expect(client.seen).toEqual([])
  })

  it('refuses a file too', async () => {
    const file = path.join(await temp(), 'package.json')
    await writeFile(file, '{}\n')
    const client = silent()
    const { code, err } = await run(['init', '--project', file], { client })
    expect(code).toBe(2)
    expect(err).toContain('is not a directory; init --project names')
    expect(client.seen).toEqual([])
  })

  it('names the working directory, not a path nobody typed, when the one it runs in is gone', async () => {
    // A shell can stand in a directory since removed: `process.cwd()` throws
    // there, or hands back a path that is no longer a directory.
    const gone = await temp()
    await rm(gone, { recursive: true })
    const said = 'the working directory no longer exists; name the service with init --project <dir>'
    const throwing = (): string => {
      throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' })
    }
    await expect(initRoot({ project: undefined, cwd: throwing, home: undefined })).rejects.toThrow(said)
    await expect(initRoot({ project: 'billing-api', cwd: throwing, home: undefined })).rejects.toThrow(said)
    await expect(initRoot({ project: undefined, cwd: () => gone, home: undefined })).rejects.toThrow(said)
  })

  it('refuses before the configuration, so nothing configured still names the directory', async () => {
    const { code, err } = await run(['init', '--project', '/nonexistent/idp-init'])
    expect(code).toBe(2)
    expect(err).not.toContain('no model configured')
  })
})

describe('Ctrl-C at a question', () => {
  /** A terminal: readline reads keys, and Ctrl-C, only when its output is one. */
  const terminal = (): { input: PassThrough; output: PassThrough } => {
    const output = new PassThrough() as PassThrough & { isTTY?: boolean }
    output.isTTY = true
    output.resume()
    return { input: new PassThrough(), output }
  }

  it('is an interruption at the prompt, not a decline', async () => {
    const { input, output } = terminal()
    const answered = promptOnTerminal(input, output)({ path: 'operations.0.entity.spec.owner', question: 'who owns it?' })
    input.write('\u0003')
    await expect(answered).rejects.toBeInstanceOf(InterruptedError)
  })

  it('leaves Ctrl-D a decline', async () => {
    const { input, output } = terminal()
    const answered = promptOnTerminal(input, output)({ path: 'operations.0.entity.spec.owner', question: 'who owns it?' })
    input.end()
    expect(await answered).toBeUndefined()
  })

  it('exits 130, the code a shell gives an interrupted command', async () => {
    const repo = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
    const { code, out, err } = await run(
      ['plan', '--from', path.resolve(import.meta.dirname, '../../examples/declare-database.json'), '--repo', repo],
      {
        ask: async () => {
          throw new InterruptedError()
        },
      },
    )
    expect({ code, out }).toEqual({ code: 130, out: '' })
    expect(err).toContain('interrupted; nothing was written')
  })
})
