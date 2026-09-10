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

async function importsUnder(dir: string): Promise<Import[]> {
  const found: Import[] = []
  for (const file of await sourceFiles(dir)) {
    const content = await readFile(file, 'utf8')
    for (const pattern of PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const specifier = match[1]
        if (specifier !== undefined) {
          found.push({ file: path.relative(SOURCE_ROOT, file), specifier })
        }
      }
    }
  }
  return found
}

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
})
