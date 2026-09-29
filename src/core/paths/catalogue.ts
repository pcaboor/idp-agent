/**
 * Which files of a declarations repository are catalogue.
 *
 * Two readers ask, and they must not disagree: `context/iac-fs` walks a
 * directory, and the forge proves a commit holds exactly what the gates judged.
 * A file one of them counts and the other does not is a file a submission
 * could carry past every gate — so the rule lives here once, and a test walks a
 * real directory to prove the reader uses it.
 *
 * Hidden is tooling, never catalogue: `.github` holds workflows, `.git`
 * objects, `.idp-agent.yml` this tool's own configuration, and a `.witness.yml`
 * declares nothing (design §4.4). `node_modules` is somebody else's.
 *
 * About names only. Whether a file is a symbolic link is a question about its
 * type, which B3 answers (docs/roadmap.md), not this predicate.
 */
const YAML = /\.ya?ml$/

export const isCatalogueFolder = (name: string): boolean =>
  !name.startsWith('.') && name !== 'node_modules'

export function isCataloguePath(relative: string): boolean {
  const segments = relative.split('/')
  const file = segments.pop()
  if (file === undefined || file.startsWith('.') || !YAML.test(file)) return false
  return segments.every(isCatalogueFolder)
}
