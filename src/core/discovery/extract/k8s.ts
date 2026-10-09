import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, visit, type Node, type YAMLMap } from 'yaml'
import { readDocuments, type DocumentReading } from '../../yaml/serialize.js'
import { discardedWhole } from '../allow.js'
import { looksLikeConnection, parseConnection } from '../connection.js'
import type { FileFacts, ParseFailure } from '../extractors.js'
import { mintFinding, type Draft, type Finding, type Reference } from '../finding.js'

/**
 * Kubernetes manifests (plan, Task 2.4): two rules over the container
 * environment of a workload's pod template. `k8s.env-value`, an `env[].value`
 * that opens like a connection, read as `env-file` reads a line — the same
 * parser, the same grammars, its password dropped; and `k8s.reference`, a
 * `valueFrom.secretKeyRef` or `configMapKeyRef` (its name and key) or an
 * `envFrom` source (its name), named and never read: configured outside this
 * repository. A finding's span is its entry, from its first line to its last.
 *
 * It reads FIELD NAMES OF THE FORMAT, and nothing else: a document's `kind`,
 * the fixed keys down to its pod's spec, and a container's `env` and
 * `envFrom`. A `ConfigMap`'s `data` is not resolved, an annotation is not
 * read, a comment is never seen, and a `List`'s items are never read, a
 * workload among them: a List is opened only to be discarded when it holds a
 * Secret. A whole value that names another (`$(DB_URL)`, `${DB_URL}`, `{{ … }}`)
 * opens like no connection, so it states nothing; one inside a connection
 * (`mysql://app@$(DB_HOST)/billing`) makes it a reference, as `env-file`'s.
 *
 * A stream is read whole or not at all. One holding a Secret, a SealedSecret
 * or SOPS metadata — at its top level or in a List — is discarded whole
 * before anything is extracted (`discardedWhole`, which the read asks first
 * and this asks again), and one that cannot be read whole — a document the
 * parser faulted, a key written twice, an alias bomb past `readDocuments`'s
 * bound, a List that holds itself, a merge Kubernetes refuses, more documents
 * than `maxYamlDocuments` — is `not-yaml`. An alias
 * where an entry, or anything in it, should be is read as a value this
 * version could not read, never as nothing. So is a merge key (`<<: *base`),
 * which Kubernetes applies and this reads through no more than an alias: a
 * document whose kind an alias or a merge brings is reported, at its kind or
 * its merge, when that kind is a workload's, and a pod spec, a container or
 * an entry holding a merge is not read as if it held only its own keys.
 */

/** The workload kinds of version 1, as Kubernetes spells them. A change here is a new version of both rules. */
export const WORKLOAD_KINDS = Object.freeze([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
  'Pod',
] as const)
type Workload = (typeof WORKLOAD_KINDS)[number]

/** The fixed keys from a workload's document down to its pod's spec. A record, so a kind added without its path does not compile. */
const POD_SPEC: { readonly [Kind in Workload]: readonly string[] } = {
  Deployment: ['spec', 'template', 'spec'],
  StatefulSet: ['spec', 'template', 'spec'],
  DaemonSet: ['spec', 'template', 'spec'],
  ReplicaSet: ['spec', 'template', 'spec'],
  Job: ['spec', 'template', 'spec'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
  Pod: ['spec'],
}

/** A pod's containers, in both lists Kubernetes runs. */
const CONTAINER_LISTS = ['initContainers', 'containers'] as const

/** The two references of `valueFrom` read, each to its source. */
const VALUE_FROM: readonly (readonly [string, Reference['from']])[] = [
  ['secretKeyRef', 'secret'],
  ['configMapKeyRef', 'configmap'],
]

/** The two sources of `envFrom` read, each to its source. */
const ENV_FROM: readonly (readonly [string, Reference['from']])[] = [
  ['secretRef', 'secret'],
  ['configMapRef', 'configmap'],
]

const isWorkload = (kind: unknown): kind is Workload => (WORKLOAD_KINDS as readonly unknown[]).includes(kind)

/** A plain string value, or undefined: a number, a map or an alias is no name. */
const text = (node: unknown): string | undefined =>
  isScalar(node) && typeof node.value === 'string' ? node.value : undefined

/** A merge key's own node, `<<`, when a map holds one: its keys are not all its own. */
function mergeOf(map: YAMLMap): Node | undefined {
  for (const pair of map.items) if (isScalar(pair.key) && pair.key.value === '<<') return pair.key
  return undefined
}

/**
 * Whether a node holds an alias or a merge key anywhere: such an entry is not
 * read as if it said what its anchor says, nor as if it held only its own keys.
 */
function aliased(node: Node): boolean {
  if (isAlias(node)) return true
  let found = false
  visit(node, {
    Alias: () => {
      found = true
      return visit.BREAK
    },
    Pair: (_, pair) => {
      if (!isScalar(pair.key) || pair.key.value !== '<<') return undefined
      found = true
      return visit.BREAK
    },
  })
  return found
}

export function k8s(facts: FileFacts): readonly Finding[] | ParseFailure {
  // Asked again here, as the re-read hands bytes in: nothing of a stream
  // that holds a Secret is extracted, and one not read whole is no stream.
  const discarded = discardedWhole(facts.text, 'yaml')
  if (discarded === 'parse-failure') return 'not-yaml'
  if (discarded !== undefined) return []

  const lines = new LineCounter()
  let documents
  try {
    documents = parseAllDocuments(facts.text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false })
  } catch {
    // Its message quotes the bytes around the fault: never kept.
    return 'not-yaml'
  }

  // The documents as Kubernetes reads them, merge keys applied: asked only of
  // a kind this reads through an alias or a merge, and read whole already.
  let merged: readonly DocumentReading[] | undefined
  const kindAsRead = (index: number): unknown => {
    merged ??= readDocuments(facts.text, { merge: true })
    const reading = merged[index]
    if (reading === undefined || !('value' in reading)) return undefined
    const value = reading.value
    return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>)['kind'] : undefined
  }

  const lineAt = (offset: number): number => lines.linePos(offset).line
  /** A node's lines: its first character's, to its last character's. */
  const spanOf = (node: Node): readonly [number, number] => {
    const [start = 0, end = start] = node.range ?? []
    const first = lineAt(start)
    return [first, Math.max(first, lineAt(Math.max(start, end - 1)))]
  }
  const findings: Finding[] = []
  const draft = (node: Node, variable?: string) => ({
    path: facts.path,
    lines: spanOf(node),
    fileSha256: facts.fileSha256,
    standing: facts.standing,
    ...(variable === undefined ? {} : { variable }),
  })
  const mint = (made: Draft): void => void findings.push(mintFinding(made))
  /** A value this version could not read, reported at its lines, never dropped. */
  const unread = (node: Node, variable?: string): void =>
    mint({ rule: 'k8s.env-value', ...draft(node, variable), value: { connection: { outcome: 'unparsed', why: 'form' } } })
  const reference = (node: Node, from: Reference['from'], ref: unknown, keyed: boolean, variable?: string): void => {
    if (!isMap(ref) || aliased(ref)) {
      // Named outside the source's grammar: the empty name, `unparsed`.
      mint({ rule: 'k8s.reference', ...draft(node, variable), value: { reference: { from, name: '' } } })
      return
    }
    const name = text(ref.get('name', true)) ?? ''
    // A `valueFrom` reference reads one key, which a key that is no string does not name.
    const key = keyed ? (text(ref.get('key', true)) ?? '') : undefined
    mint({
      rule: 'k8s.reference',
      ...draft(node, variable),
      value: { reference: key === undefined ? { from, name } : { from, name, key } },
    })
  }

  /** One `env` entry: its value, when it opens like a connection, and the references its `valueFrom` names. */
  const envEntry = (entry: unknown): void => {
    if (!isMap(entry)) {
      if (entry !== null && typeof entry === 'object') unread(entry as Node)
      return
    }
    const variable = text(entry.get('name', true))
    if (aliased(entry)) {
      unread(entry, variable)
      return
    }
    const value = entry.get('value', true)
    if (value !== undefined && value !== null) {
      if (isScalar(value)) {
        const written = text(value)
        if (written !== undefined && written !== '' && looksLikeConnection(written) !== undefined) {
          mint({ rule: 'k8s.env-value', ...draft(entry, variable), value: { connection: parseConnection(written) } })
        }
      } else {
        unread(entry, variable)
      }
    }
    const from = entry.get('valueFrom', true)
    if (!isMap(from)) return
    for (const [field, source] of VALUE_FROM) {
      const ref = from.get(field, true)
      if (ref !== undefined && ref !== null) reference(entry, source, ref, true, variable)
    }
  }

  /** One `envFrom` entry: the Secret or the ConfigMap it hands every key of. */
  const envFromEntry = (entry: unknown): void => {
    if (!isMap(entry) || aliased(entry)) {
      if (entry !== null && typeof entry === 'object') {
        mint({ rule: 'k8s.reference', ...draft(entry as Node), value: { reference: { from: 'secret', name: '' } } })
      }
      return
    }
    for (const [field, source] of ENV_FROM) {
      const ref = entry.get(field, true)
      if (ref !== undefined && ref !== null) reference(entry, source, ref, false)
    }
  }

  /** Each item of a list a container keeps, or one unread value when the list itself is an alias. */
  const eachOf = (list: unknown, read: (item: unknown) => void): void => {
    if (isAlias(list)) unread(list)
    else if (isSeq(list)) for (const item of list.items) read(item)
  }

  const container = (node: unknown): void => {
    if (isAlias(node) || (isMap(node) && mergeOf(node) !== undefined)) {
      unread(node)
      return
    }
    if (!isMap(node)) return
    eachOf(node.get('env', true), envEntry)
    eachOf(node.get('envFrom', true), envFromEntry)
  }

  for (const [index, document] of documents.entries()) {
    if (document.errors.length > 0) return 'not-yaml'
    const contents = document.contents
    if (!isMap(contents)) continue
    const written = contents.get('kind', true)
    const merge = mergeOf(contents)
    const kind = text(written)
    if (isAlias(written) || (kind === undefined && merge !== undefined)) {
      // A kind read only through an anchor: a workload's is reported, never read through it.
      if (isWorkload(kindAsRead(index))) unread(isAlias(written) ? written : (merge ?? contents))
      continue
    }
    if (!isWorkload(kind)) continue
    if (merge !== undefined) {
      unread(merge)
      continue
    }
    let spec: unknown = contents
    let opaque = false
    for (const key of POD_SPEC[kind]) {
      if (!isMap(spec)) break
      spec = spec.get(key, true)
      if (isAlias(spec) || (isMap(spec) && mergeOf(spec) !== undefined)) {
        unread(spec)
        opaque = true
        break
      }
    }
    if (opaque || !isMap(spec)) continue
    for (const list of CONTAINER_LISTS) eachOf(spec.get(list, true), container)
  }
  return findings.sort((a, b) => a.lines[0] - b.lines[0])
}
