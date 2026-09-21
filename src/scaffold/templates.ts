import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Template bodies, read from disk once. Keys are template names rather than
 * destinations: `gitignore` is stored dotless because npm renames a packaged
 * `.gitignore` to `.npmignore`, and the mapping to `.gitignore` happens in the
 * layout.
 */
export const TEMPLATE_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../templates/iac-repo',
)

const NAMES = ['witness.yml', 'README.md', 'gitignore', 'github/workflows/validate.yml'] as const

export async function loadTemplates(directory: string = TEMPLATE_ROOT): Promise<
  ReadonlyMap<string, string>
> {
  const entries = await Promise.all(
    NAMES.map(async (name): Promise<[string, string]> => [
      name,
      await readFile(path.join(directory, name), 'utf8'),
    ]),
  )
  return new Map(entries)
}
