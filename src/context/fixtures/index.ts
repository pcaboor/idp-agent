import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CatalogueEntity, OrganisationEntity } from '../../core/schemas/entity.js'
import { parseDocuments } from '../../core/yaml/serialize.js'
import { isCatalogueFolder, isCataloguePath } from '../../core/paths/catalogue.js'
import type { ContextProvider, Ignored, LoadResult, Rejection } from '../provider.js'


async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      // A hidden directory is tooling, not catalogue: .github holds workflows
      // that are YAML and are not entities. Reading them would make a freshly
      // scaffolded repository report rejections for its own CI config. The
      // rule is iac-fs's (`core/paths/catalogue.ts`), so the demo SI and a
      // declarations repository are read alike. This walker used to read a
      // hidden file too, and no longer does: the demo's are `.witness.yml`s,
      // which declare nothing, so no entity is lost.
      if (entry.isDirectory()) return isCatalogueFolder(entry.name) ? yamlFiles(full) : []
      // The name alone: every folder above it was held to the same rule.
      return isCataloguePath(entry.name) ? [full] : []
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
    const entities: CatalogueEntity[] = []
    const rejected: Rejection[] = []
    const ignored: Ignored[] = []
    const unread: string[] = []
    const organisation: OrganisationEntity[] = []

    for (const file of await yamlFiles(this.rootDir)) {
      const source = path.relative(this.rootDir, file)
      const content = await readFile(file, 'utf8')

      // The one reader of entity documents: a document the parser faulted is
      // a rejection here too, never the value `toJS()` would have guessed.
      const read = parseDocuments(content)
      entities.push(...read.entities, ...read.apis)
      rejected.push(...read.rejections.map((reason) => ({ source, reason })))
      ignored.push(...read.ignored.map((document) => ({ source, ...document })))
      unread.push(...read.unread)
      organisation.push(...read.organisation)
    }

    // No `judged`: a folder's Group files are what it holds, not the
    // organisation, so a reference to one of its kinds is never judged here.
    return { entities, rejected, ignored, unread, ...(organisation.length > 0 && { organisation }) }
  }
}
