import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Entity } from '../../core/schemas/entity.js'
import { parseDocuments } from '../../core/yaml/serialize.js'
import type { ContextProvider, Ignored, LoadResult, Rejection } from '../provider.js'


const YAML_EXTENSIONS = new Set(['.yml', '.yaml'])

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      // A hidden directory is tooling, not catalogue: .github holds workflows
      // that are YAML and are not entities. Reading them would make a freshly
      // scaffolded repository report rejections for its own CI config.
      if (entry.isDirectory()) {
        return entry.name.startsWith('.') || entry.name === 'node_modules' ? [] : yamlFiles(full)
      }
      return YAML_EXTENSIONS.has(path.extname(entry.name)) ? [full] : []
    }),
  )
  return nested.flat().sort()
}

/**
 * Reads a directory laid out exactly like an IaC repository, so the fixture SI
 * is a valid repository rather than a test-only shape.
 */
export class FixtureProvider implements ContextProvider {
  readonly name = 'fixtures'

  constructor(private readonly rootDir: string) {}

  async load(): Promise<LoadResult> {
    const entities: Entity[] = []
    const rejected: Rejection[] = []
    const ignored: Ignored[] = []

    for (const file of await yamlFiles(this.rootDir)) {
      const source = path.relative(this.rootDir, file)
      const content = await readFile(file, 'utf8')

      // The one reader of entity documents: a document the parser faulted is
      // a rejection here too, never the value `toJS()` would have guessed.
      const read = parseDocuments(content)
      entities.push(...read.entities)
      rejected.push(...read.rejections.map((reason) => ({ source, reason })))
      ignored.push(...read.ignored.map((document) => ({ source, ...document })))
    }

    return { entities, rejected, ignored }
  }
}
