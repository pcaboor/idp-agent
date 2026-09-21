import type { Entity } from '../schemas/entity.js'
import { resolveEntityPath } from '../paths/entity-path.js'

/**
 * What CI must refuse. The catalogue ingests a duplicate in silence and lets
 * the first source win (design 4.4), so the repository needs a gate the
 * catalogue does not provide. Pure: this file reads no disk and knows no path
 * beyond the ones it is handed.
 */
export type Rule =
  | 'duplicate-name'
  | 'invalid-entity'
  | 'multiple-entities'
  | 'missing-witness'
  | 'misplaced-entity'
  | 'dangling-reference'

export type Severity = 'error' | 'warning'

export interface Violation {
  readonly rule: Rule
  /** Repository-relative, POSIX. A folder rule anchors on the folder. */
  readonly file: string
  readonly message: string
  readonly severity: Severity
}

/** One parsed file, with the provenance a ContextProvider discards. */
export interface RepositoryFile {
  readonly path: string
  readonly entities: readonly Entity[]
  /** One message per document the schema refused. Reported, never dropped. */
  readonly rejections: readonly string[]
  /** Documents in the file, including the null ones a witness is made of. */
  readonly documents: number
}

export interface RepositorySnapshot {
  /** Every directory found, repository-relative. Extra folders are tolerated. */
  readonly folders: readonly string[]
  /** Those holding a `.witness.yml`. Found by readdir, never by a glob. */
  readonly witnesses: readonly string[]
  readonly files: readonly RepositoryFile[]
}

const refOf = (entity: Entity): string =>
  `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`

const folderOfFile = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

const referencesOf = (entity: Entity): string[] => [
  ...(entity.spec.dependsOn ?? []),
  ...(entity.kind === 'Resource' ? (entity.spec.dependencyOf ?? []) : []),
]

export function checkRepository(snapshot: RepositorySnapshot): Violation[] {
  const violations: Violation[] = []
  const declared = new Set<string>()
  const byRef = new Map<string, string[]>()

  for (const file of snapshot.files) {
    for (const entity of file.entities) {
      const ref = refOf(entity)
      declared.add(ref)
      byRef.set(ref, [...(byRef.get(ref) ?? []), file.path])
    }
  }

  // A duplicate is one violation naming every file involved: reporting one of
  // them would leave the reader hunting for the other, which is the whole
  // difficulty of the bug.
  for (const [ref, paths] of [...byRef].sort(([left], [right]) => left.localeCompare(right))) {
    if (paths.length < 2) continue
    violations.push({
      rule: 'duplicate-name',
      file: [...paths].sort()[0] ?? '',
      severity: 'error',
      message: `${ref} is declared in ${[...paths].sort().join(', ')}`,
    })
  }

  // A file already faulted for holding several entities, or for duplicating a
  // name, will also look misplaced — a second entity cannot be at the first
  // one's path. Reporting both states the same fault twice and buries the
  // cause under its consequence.
  const structurallyFaulted = new Set<string>([
    ...snapshot.files.filter((file) => file.entities.length > 1).map((file) => file.path),
    ...[...byRef.values()].filter((paths) => paths.length > 1).flat(),
  ])

  for (const file of snapshot.files) {
    for (const rejection of file.rejections) {
      violations.push({
        rule: 'invalid-entity',
        file: file.path,
        severity: 'error',
        message: rejection,
      })
    }

    if (file.entities.length > 1) {
      violations.push({
        rule: 'multiple-entities',
        file: file.path,
        severity: 'error',
        message: `${file.entities.length} entities in one file; one file per entity`,
      })
    }

    for (const entity of file.entities) {
      if (structurallyFaulted.has(file.path)) continue
      let expected: string
      try {
        expected = resolveEntityPath(entity)
      } catch {
        // A Component has no conventional location — it lives in its own
        // repository, and resolveEntityPath throws rather than invent one.
        // A throw here means there is nothing to check, not a failure.
        continue
      }
      if (expected !== file.path) {
        violations.push({
          rule: 'misplaced-entity',
          file: file.path,
          severity: 'error',
          message: `${refOf(entity)} belongs at ${expected}`,
        })
      }
    }
  }

  // Only folders that actually hold an entity. schemas/ and .github/ are
  // folders too, and the rule is about where entities live.
  const holding = new Set(
    snapshot.files.filter((file) => file.entities.length > 0).map((file) => folderOfFile(file.path)),
  )
  const witnessed = new Set(snapshot.witnesses)
  for (const folder of [...holding].sort()) {
    if (witnessed.has(folder)) continue
    violations.push({
      rule: 'missing-witness',
      file: folder,
      severity: 'error',
      message: 'holds entities and has no .witness.yml; a pattern with no match must fail',
    })
  }

  // Warning, not error. A reference pointing at nothing is reported and never
  // pruned (design 4.4) — but a repository mid-migration is not broken, and a
  // red build here pushes people to delete the declaration, which is the one
  // thing that rule forbids.
  for (const file of snapshot.files) {
    for (const entity of file.entities) {
      for (const reference of referencesOf(entity)) {
        if (declared.has(reference)) continue
        violations.push({
          rule: 'dangling-reference',
          file: file.path,
          severity: 'warning',
          message: `${refOf(entity)} names ${reference}, which nothing declares`,
        })
      }
    }
  }

  return [
    ...violations.filter((violation) => violation.severity === 'error'),
    ...violations.filter((violation) => violation.severity === 'warning'),
  ]
}
