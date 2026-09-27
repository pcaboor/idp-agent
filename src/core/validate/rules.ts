import { SOURCE_FILE_ANNOTATION, type Api, type Entity } from '../schemas/entity.js'
import { PathEscapeError, resolveEntityPath } from '../paths/entity-path.js'
import { parseDocuments, type IgnoredDocument } from '../yaml/serialize.js'
import {
  REGISTRATION_FILE,
  isLocationKind,
  registrationsIn,
  type Registration,
} from './registration.js'

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
  | 'not-modelled'
  | 'registration'
  | 'unreadable-folder'

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
  /**
   * Backstage APIs: read, validated for what the reader requires of one, and
   * never among `entities` — the write side reads that list alone, so no plan
   * amends, counts or files an API (see `parseDocuments`).
   */
  readonly apis: readonly Api[]
  /** One message per document the schema refused. Reported, never dropped. */
  readonly rejections: readonly string[]
  /**
   * Documents set aside as someone else's — a Group, a System, a mkdocs.yml.
   * Reported, never refused, and never an entity to any other rule.
   */
  readonly ignored: readonly IgnoredDocument[]
  /** Documents in the file, including the null ones a witness is made of. */
  readonly documents: number
  /**
   * The Backstage registration — each `kind: Location` of the root
   * `catalog-info.yaml` (`registration.ts`). Absent from every other file, and
   * from that one when it holds no Location. Not among `ignored`: it is this
   * repository's own wiring, read and held to Backstage's Location shape.
   */
  readonly registrations?: readonly Registration[]
}

/**
 * A file as every reader of a repository sees it, from its path and its text:
 * `parseDocuments`, and at the root the registration taken out of what it sets
 * aside. One definition, so `validate`, the read commands and the re-check of a
 * plan cannot disagree about which Location is the registration.
 */
export function repositoryFileOf(path: string, text: string): RepositoryFile {
  const parsed = parseDocuments(text)
  if (path !== REGISTRATION_FILE) return { path, ...parsed }
  const registrations = registrationsIn(text)
  if (registrations.length === 0) return { path, ...parsed }
  return {
    path,
    ...parsed,
    ignored: parsed.ignored.filter((document) => !isLocationKind(document.kind)),
    registrations,
  }
}

export interface RepositorySnapshot {
  /** Every directory found, repository-relative. Extra folders are tolerated. */
  readonly folders: readonly string[]
  /** Those holding a `.witness.yml`. Found by readdir, never by a glob. */
  readonly witnesses: readonly string[]
  readonly files: readonly RepositoryFile[]
  /**
   * The folders the reader could not list, `''` for the root, each with why.
   * Absent is none. What they hold was never read, so a rule that found
   * nothing there found nothing because it looked at nothing.
   */
  readonly unreadable?: readonly UnreadableFolder[]
}

/** A folder `readdir` refused: repository-relative, POSIX, and the error code. */
export interface UnreadableFolder {
  readonly path: string
  readonly reason: string
}

const refOf = (entity: Entity | Api): string =>
  `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`

/** Whether an entity says where it lives, as `resolveEntityPath` reads it. */
const namesItsFile = (entity: Entity): boolean =>
  (entity.metadata.annotations[SOURCE_FILE_ANNOTATION] ?? '') !== ''

const folderOfFile = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

const referencesOf = (entity: Entity): string[] => [
  ...(entity.spec.dependsOn ?? []),
  ...(entity.kind === 'Resource' ? (entity.spec.dependencyOf ?? []) : []),
  ...(entity.kind === 'Component' ? (entity.spec.providesApis ?? []) : []),
]

export function checkRepository(snapshot: RepositorySnapshot): Violation[] {
  const violations: Violation[] = []

  // An error, not a warning: a folder under chmod 000 lost every entity in it,
  // and `validate` said "0 violations" on exit 0 — compliant, about what it
  // never read (review, runtime-probe-3). A duplicate or a dangling reference
  // can sit in there, and CI is the one place that would have said so.
  for (const folder of snapshot.unreadable ?? []) {
    violations.push({
      rule: 'unreadable-folder',
      file: folder.path === '' ? '.' : folder.path,
      severity: 'error',
      message: `could not be listed (${folder.reason}); nothing in it was checked`,
    })
  }

  const declared = new Set<string>()
  const byRef = new Map<string, string[]>()

  // What a set-aside document declares is not an entity to any rule, but it is
  // there: a reference to it is not dangling, only to something not modelled.
  const aside = new Set<string>()

  // An API is declared like any entity — a reference to it resolves, and two
  // of one name are a duplicate — and is subject to no other rule: this tool
  // never files one, so it has no path to be misplaced from, no witness to
  // demand and no one-per-file to hold it to. A catalog-info.yaml holding a
  // service and the API it provides is the commonest shape a catalogue has.
  for (const file of snapshot.files) {
    for (const entity of [...file.entities, ...file.apis]) {
      const ref = refOf(entity)
      declared.add(ref)
      byRef.set(ref, [...(byRef.get(ref) ?? []), file.path])
    }
    for (const { ref } of file.ignored) if (ref !== undefined) aside.add(ref)
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
    // Warning, not error: a repository that is also the company's catalogue
    // declares Groups and Systems beside the entities this tool manages, and a
    // red build there would push people to move them out — or to delete them.
    // Named, because a document read and never mentioned is one the user
    // believes was checked.
    for (const ignored of file.ignored) {
      violations.push({
        rule: 'not-modelled',
        file: file.path,
        severity: 'warning',
        message: ignored.reason,
      })
    }

    // Counted in silence when it registers every folder: the file is there on
    // purpose, and a line on every repository `init platform` creates would be
    // noise. What Backstage would refuse, or what reads outside the repository,
    // fails the build; a folder no target reaches is said, and does not.
    for (const registration of file.registrations ?? []) {
      for (const fault of registration.faults) {
        violations.push({
          rule: 'registration',
          file: file.path,
          severity: 'error',
          message: `the Backstage registration ${fault}`,
        })
      }
      if (registration.faults.length > 0 || registration.unreached.length === 0) continue
      violations.push({
        rule: 'registration',
        file: file.path,
        severity: 'warning',
        message:
          `the Backstage registration does not reach ${registration.unreached.join(', ')}: ` +
          'Backstage ingests nothing filed there',
      })
    }

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
      // A Component that names no file has no conventional location — it
      // lives in its own repository, and resolveEntityPath throws rather than
      // invent one. There is nothing to check, which is not a failure. That
      // case alone: the catch used to take every throw, so an annotation
      // naming a file outside the repository passed in silence.
      if (entity.kind === 'Component' && !namesItsFile(entity)) continue
      let expected: string
      try {
        expected = resolveEntityPath(entity)
      } catch (error) {
        if (!(error instanceof PathEscapeError)) throw error
        violations.push({
          rule: 'misplaced-entity',
          file: file.path,
          severity: 'error',
          message: `${refOf(entity)} ${error.message}`,
        })
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
        if (declared.has(reference) || aside.has(reference)) continue
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
