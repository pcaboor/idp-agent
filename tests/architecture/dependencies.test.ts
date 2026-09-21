import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../../src')

interface Import {
  file: string
  specifier: string
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return entry.name.endsWith('.ts') ? [full] : []
    }),
  )
  return nested.flat()
}

/** Static imports and re-exports, plus dynamic import() and require(). */
const PATTERNS = [
  /^\s*(?:import|export)\b[^'"]*['"]([^'"]+)['"]/gm,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g,
]

async function importsOf(file: string): Promise<Import[]> {
  const content = await readFile(file, 'utf8').catch(() => '')
  const found: Import[] = []
  for (const pattern of PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) {
        found.push({ file: path.relative(SOURCE_ROOT, file), specifier })
      }
    }
  }
  return found
}

async function importsUnder(dir: string): Promise<Import[]> {
  const nested = await Promise.all((await sourceFiles(dir)).map(importsOf))
  return nested.flat()
}

/**
 * Every import reachable from an entry file, not only the ones written in it.
 * Relative specifiers are resolved and walked; a bare specifier is recorded and
 * not walked. Grepping one directory would let agents/ -> llm/client ->
 * recording -> node:fs pass, while SECURITY.md claims there is no code path from
 * an agent to the disk. This is that claim, made checkable.
 */
async function closureOf(entry: string, seen = new Set<string>()): Promise<Import[]> {
  if (seen.has(entry)) return []
  seen.add(entry)

  const found: Import[] = []
  for (const imported of await importsOf(entry)) {
    found.push(imported)
    if (!imported.specifier.startsWith('.')) continue
    const resolved = path.resolve(path.dirname(entry), imported.specifier.replace(/\.js$/, '.ts'))
    found.push(...(await closureOf(resolved, seen)))
  }
  return found
}

const MODEL_SDK = /^ai$|^@ai-sdk\//
const DISK =
  /^(node:)?(fs|fs\/promises|child_process|worker_threads|module)$|^(simple-git|isomorphic-git|nodegit)$/
const NETWORK = /^(node:)?(http|https|net|dgram|tls)$|^(undici|axios|node-fetch|got)$/

describe('architecture', () => {
  it('core/ does not import agents/ or llm/', async () => {
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      /(^|\/)(agents|llm)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('core/ does not reach the network', async () => {
    const network = /^(node:)?(http|https|net|dgram|tls)$|^(undici|axios|node-fetch|got)$/
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      network.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('agents/ does not import fs, git or child_process', async () => {
    // The guardrail is structural: there is no code path from an agent to the
    // disk, and this is what keeps it true once someone else contributes.
    const forbidden =
      /^(node:)?(fs|fs\/promises|child_process)$|^(simple-git|isomorphic-git|nodegit)$/
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'agents'))).filter(
      ({ specifier }) => forbidden.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('no module reachable from agents/ touches the disk or the network', async () => {
    const entries = await sourceFiles(path.join(SOURCE_ROOT, 'agents'))
    const closure = (await Promise.all(entries.map((file) => closureOf(file)))).flat()
    const offending = closure.filter(
      ({ specifier }) => DISK.test(specifier) || NETWORK.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('only src/llm/ imports the model SDK', async () => {
    // One crossing point (design 10). It is also why llm/client.ts holds types
    // only: agents/ imports it, and the closure above walks through it.
    const offending = (await importsUnder(SOURCE_ROOT)).filter(
      ({ file, specifier }) => MODEL_SDK.test(specifier) && !file.startsWith('llm/'),
    )
    expect(offending).toEqual([])
  })

  it('agents/ imports llm/client.js and nothing else from llm/', async () => {
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'agents'))).filter(
      ({ specifier }) => /(^|\/)llm\//.test(specifier) && !/llm\/client\.js$/.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('scaffold/ imports core/ and nothing else of ours', async () => {
    // It derives a layout and writes it. It has no business knowing about a
    // model, a graph, or the CLI that calls it.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'scaffold'))).filter(
      ({ specifier }) => /(^|\/)(agents|llm|context|cli)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('only two modules in scaffold/ touch the disk, and only one of them writes', async () => {
    // Two different interactions, and conflating them made this rule wrong on
    // its first run: templates.ts *reads* files shipped inside the package,
    // write.ts *writes* into someone else's repository. Only the second is the
    // seam stage 5's atomic applier replaces — one file is a refactor, five
    // would be a rewrite — but both have to be named, or the rule is a lie.
    const allowed = new Set(['scaffold/write.ts', 'scaffold/templates.ts'])
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'scaffold'))).filter(
      ({ file, specifier }) => DISK.test(specifier) && !allowed.has(file),
    )
    expect(offending).toEqual([])
  })

  it('nothing in scaffold/ but write.ts imports a writing function', async () => {
    // The distinction the rule above cannot make from a module specifier.
    const writers = /\b(writeFile|mkdir|rm|rename|appendFile|cp)\b/
    const sources = await sourceFiles(path.join(SOURCE_ROOT, 'scaffold'))
    const offending: string[] = []
    for (const source of sources) {
      const relative = path.relative(SOURCE_ROOT, source)
      if (relative === 'scaffold/write.ts') continue
      const body = await readFile(source, 'utf8')
      const imports = body.match(/^import \{[^}]*\} from '[^']*fs[^']*'/gm) ?? []
      if (imports.some((line) => writers.test(line))) offending.push(relative)
    }
    expect(offending).toEqual([])
  })

  it('core/ neither reads nor writes', async () => {
    // core/README.md has said so since stage 2 and nothing checked it.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      DISK.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('core/ does not reach the model SDK', async () => {
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      MODEL_SDK.test(specifier),
    )
    expect(offending).toEqual([])
  })
})
