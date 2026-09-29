import type { FileEdit } from '../diff/unified.js'
import { isCatalogInfoPath, type Operation, type Plan } from '../schemas/plan.js'
import { documentNames, serializeEntity } from '../yaml/serialize.js'
import { insertDocument } from '../yaml/surgery.js'
import type { DroppedOperation } from './edits.js'
import { materialise } from './materialise.js'

/**
 * Where `init` files a service's Component, and the bytes it leaves there — in
 * the SERVICE's own repository, which no other module of `core/plan/` writes
 * for.
 *
 * Moved out of `cli/commands/init.ts` (stage 5, task 2), all of it pure, so
 * that the preview `init` prints and the clearance a forge is handed
 * (`clearService`) are one reading rather than two that agree until they do
 * not: the same `targetOf` over the same kept declarations, the same
 * `filedIn(asCatalogInfo(op), target)`, the same bytes. A clearance that read
 * the root's `catalog-info.yaml` alone filed a twin beside the `.yml` a service
 * keeps (#82).
 */

/**
 * Where a service declares itself when it keeps no catalog-info yet.
 * Backstage's own convention, at the root of the repository the CLI was
 * pointed at.
 *
 * Never a field: §5.2 says the engine chooses where a declaration is filed,
 * and this is that choice for the one operation whose file lives outside the
 * declarations repository. A repository that already keeps one — a `.yml`,
 * or one in another folder — is added to where it keeps it (`targetOf`).
 */
export const CATALOG_INFO = 'catalog-info.yaml'

/**
 * The operation §7.3 names, minted by the engine out of a proposal the
 * signature has already vouched for.
 *
 * The order is the whole of it. Minting first put `repoPath` in front of
 * `signPlan`, which classifies a leaf by where it came from and has no class
 * for "the engine wrote this" — so `catalog-info.yaml` came out `novel` and the
 * CLI asked the user which path it should be, about a path chosen by the code
 * putting the question. Provenance is a question about what a MODEL wrote, and
 * this field was never the model's to write.
 *
 * One argument, as stage 5's plan moves it (docs/stage-8-brief.md §11); the
 * file a repository already keeps is a second step, `filedIn`.
 */
export const asCatalogInfo = (operation: Operation): Operation =>
  operation.op === 'create-entity' && operation.entity.kind === 'Component'
    ? { op: 'create-catalog-info', repoPath: CATALOG_INFO, entity: operation.entity }
    : operation

/** A minted operation, filed where the engine chose (`targetOf`), never the model. */
export const filedIn = (operation: Operation, repoPath: string): Operation =>
  operation.op === 'create-catalog-info' ? { ...operation, repoPath } : operation

/** A document's identity as it states it: kind + namespace + name, unchecked. */
export interface Identity {
  readonly kind: string | undefined
  readonly namespace: string
  readonly name: string
}

/**
 * The identities a file states, and whether one of its documents states a kind
 * or a name nobody can read.
 *
 * Read by `documentNames`, which reads the stream as `parseDocuments` does —
 * with or without `---`, in CRLF or not — and without the schema: a Component
 * this tool would not write (a lifecycle of `unknown`, a name in upper case)
 * is still that Component to Backstage, and to this. Identity is kind +
 * namespace + name (review, core-yaml-4): an API or a Resource of the same
 * name is another entity. A namespace a document does not state is
 * Backstage's `default`.
 */
export function identitiesOf(text: string): { identities: Identity[]; unreadable: boolean } {
  const { named, unreadable } = documentNames(text)
  return {
    identities: named.map((document) => ({
      kind: document.kind,
      namespace: document.namespace ?? 'default',
      name: document.name,
    })),
    // A document with a name and no kind is refused by the reader, and may be
    // a Component: nobody can say, so it counts as unreadable.
    unreadable: unreadable || named.some((document) => document.kind === undefined),
  }
}

/** Backstage compares references case-insensitively. */
export const fold = (text: string): string => text.toLowerCase()

export const isComponent = (identity: Identity): boolean => fold(identity.kind ?? '') === 'component'

/** Whether `identity` is `component:default/<name>` — what init writes. */
export const isThis = (identity: Identity, name: string): boolean =>
  isComponent(identity) && fold(identity.namespace) === 'default' && fold(identity.name) === fold(name)

/** Whether a file declares the Component init would write under `name`. */
export const declaresComponent = (text: string, name: string): boolean =>
  identitiesOf(text).identities.some((identity) => isThis(identity, name))

/**
 * Folders whose catalog-info describes something other than the service: a
 * test's fixture, an example, a template not rendered yet. Never where init
 * files the service, never what it compares with, and never what stops it.
 */
const SET_ASIDE = new Set([
  '__fixtures__',
  '__snapshots__',
  '__tests__',
  'e2e',
  'example',
  'examples',
  'fixture',
  'fixtures',
  'sample',
  'samples',
  'skeleton',
  'spec',
  'template',
  'templates',
  'test',
  'testdata',
  'tests',
])

export const isSetAside = (file: string): boolean =>
  file
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((folder) => SET_ASIDE.has(folder))

/**
 * Which file a new Component is added to — the engine's choice, never the
 * model's (§5.2): the root's `catalog-info.yaml`, else the root's `.yml`, else
 * the one plain catalog-info the repository keeps elsewhere, else a new
 * `catalog-info.yaml` at the root. A catalog-info in a workspace — a folder
 * with its own package manifest — is that workspace's, and one in a test's or
 * an example's folder is set aside before this is asked (`isSetAside`). Two
 * or more elsewhere and none at the root is a monorepo's, each folder's own,
 * and none of them is this one.
 */
export function targetOf(declarations: readonly { readonly path: string; readonly workspace?: string }[]): string {
  for (const root of [CATALOG_INFO, 'catalog-info.yml']) {
    if (declarations.some((file) => file.path === root)) return root
  }
  // A plain catalog-info, by the test a Plan's `repoPath` is held to: one in
  // a hidden folder — `.github` is walked — is never where init files the
  // service, since the plan naming it would be refused.
  const elsewhere = declarations.filter(
    (file) => isCatalogInfoPath(file.path) && file.workspace === undefined,
  )
  return elsewhere.length === 1 && elsewhere[0] !== undefined ? elsewhere[0].path : CATALOG_INFO
}

/**
 * The bytes a `create-catalog-info` would leave behind, in the SERVICE's own
 * repository.
 *
 * `planEdits` cannot do this and says so where it drops the operation: it
 * composes bytes for the declarations repository, and `repoPath` names a file
 * in a different one. What this does NOT do is compose them differently —
 * `materialise` is still the one translation from a proposal to an entity,
 * `serializeEntity` the one serialiser and `insertDocument` the one thing that
 * writes a document marker. This function supplies the repository those three
 * have no reader for, and nothing else.
 *
 * `files` are the catalog-info files the repository keeps, whole: the
 * `before` of every edit is read from them, so they must never be a capped
 * snapshot's.
 *
 * Under the effect check `planEdits` has (#45): an operation that leaves no
 * declaration of its Component behind is in `dropped`, with the reason, and
 * never skipped in silence. The preview would otherwise print "nothing to
 * change" for a plan that declared nothing, and a clearance would cut a branch
 * that does not carry what it says.
 */
export function catalogInfoEdits(
  plan: Plan,
  snapshot: { readonly files: readonly { readonly path: string; readonly text: string }[] },
): { edits: FileEdit[]; dropped: DroppedOperation[] } {
  /**
   * Keyed by PATH, never by operation — the same rule `planEdits` states and
   * for the same reason, which is why it is repeated here rather than assumed:
   * every `create-catalog-info` in a plan points at the SAME
   * `catalog-info.yaml`, so one edit per operation printed two "create this
   * file from /dev/null" hunks for one path, each computed against the
   * untouched original, and called it two files. A diff is a statement about a
   * file, not about the work that produced it.
   */
  const buffered = new Map<string, string>()
  const order: string[] = []
  const original = new Map<string, string | undefined>()
  const dropped: DroppedOperation[] = []

  for (const [opIndex, operation] of plan.operations.entries()) {
    if (operation.op !== 'create-catalog-info') continue
    const entity = materialise(operation.entity)
    if (entity === undefined) {
      // Never a silent skip (#45): a caller printing a diff must be able to say
      // "this plan declares nothing" rather than "nothing to change".
      dropped.push({ opIndex, reason: 'the proposed Component could not be materialised' })
      continue
    }

    const path = operation.repoPath
    if (!original.has(path)) {
      original.set(path, snapshot.files.find((file) => file.path === path)?.text)
    }
    // Through the buffer, so a second component composes onto the first rather
    // than replacing it.
    const existing = buffered.get(path) ?? original.get(path)
    // Decided by kind, namespace and name as the documents state them —
    // never by a scan for `name:` lines, which needed a `---` and took an API
    // of the same name for this Component (review, core-yaml-4).
    const declared = existing !== undefined && declaresComponent(existing, entity.metadata.name)
    // Already declared there: an edit whose two sides are equal, so the diff
    // comes out empty rather than absent. Absent means already done (§4.3),
    // but only if it is visible — and a repository re-inits after a merge.
    const after = declared ? existing : insertDocument(existing ?? '', serializeEntity(entity))

    // The effect, read back from the bytes: a document appended after an open
    // quoted scalar is swallowed by it, and the file changes while declaring
    // nothing (measured). What was meant is not what was written, so nothing
    // of it is kept — as `planEdits` keeps nothing of an operation it drops.
    if (!declaresComponent(after, entity.metadata.name)) {
      dropped.push({ opIndex, reason: `${path}: the edit did not declare it` })
      continue
    }
    if (!order.includes(path)) order.push(path)
    buffered.set(path, after)
  }

  return {
    edits: order.map((path) => ({
      path,
      before: original.get(path),
      after: buffered.get(path) ?? '',
    })),
    dropped,
  }
}
