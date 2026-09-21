import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import { entitySchema, type Entity } from '../../core/schemas/entity.js'
import type { ContextProvider, LoadResult, Rejection } from '../provider.js'

/**
 * Zod puts the offending field in the issue's path and not in its message, so
 * `issues[0].message` alone says something is wrong without saying what. The
 * dotted path is the half a reader needs — the same form `findUnknowns`
 * already reports for a Plan.
 */
function reasonOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid entity'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

const YAML_EXTENSIONS = new Set(['.yml', '.yaml'])

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return yamlFiles(full)
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

    for (const file of await yamlFiles(this.rootDir)) {
      const source = path.relative(this.rootDir, file)
      const content = await readFile(file, 'utf8')

      for (const document of parseAllDocuments(content)) {
        const value: unknown = document.toJS()
        // A witness file declares nothing; its absence is what would be an error.
        if (value === null || value === undefined) continue

        const parsed = entitySchema.safeParse(value)
        if (parsed.success) entities.push(parsed.data)
        else {
          rejected.push({ source, reason: reasonOf(parsed.error) })
        }
      }
    }

    return { entities, rejected }
  }
}
