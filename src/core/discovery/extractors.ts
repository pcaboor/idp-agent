import { createHash } from 'node:crypto'
import { allowed, type FileStanding } from './allow.js'
import { envFile } from './extract/env-file.js'
import { k8s } from './extract/k8s.js'
import { npm } from './extract/npm.js'
import type { Finding } from './finding.js'
import { DISCOVERY_LIMITS } from './limits.js'
import type { ExtractorName } from './rules.js'
import type { Extract } from './verify.js'

/**
 * The extractors, by the name the allow-list gives a file: slice 1's (plan,
 * Task 1.4) `env-file`, the sample family's connection strings, and `npm`, a
 * `package.json`'s name and the clients of a closed table it installs; and
 * slice 2's `k8s` (Task 2.4), a Kubernetes manifest's container environment.
 * Pure: bytes in, typed findings out, each made by `mintFinding`.
 *
 * Every extractor wraps its whole body in one `try`, and what it cannot read
 * is a closed reason of the engine's (`ParseFailure`), never a parser's
 * message: Node's `JSON.parse` and `yaml` quote the bytes around a fault, and
 * a message kept anywhere reaches stderr or a trace.
 */

/** Why a file did not parse: a closed list of the engine's, never a parser's message. */
export type ParseFailure =
  | 'not-json'
  | 'duplicate-key'
  | 'not-an-object'
  | 'too-deep'
  | 'not-utf8'
  | 'unclosed-quote'
  | 'not-yaml'

export type Extracted =
  | { readonly outcome: 'read'; readonly findings: readonly Finding[] }
  | { readonly outcome: 'parse-failure'; readonly why: ParseFailure }
  | { readonly outcome: 'over-finding-cap'; readonly count: number }

/** What an extractor is handed beside the bytes: what the allow-list and the bytes say of the file. */
export interface FileFacts {
  readonly path: string
  readonly text: string
  readonly fileSha256: string
  readonly standing: FileStanding
}

/** `fatal`: a byte that is not UTF-8 is a parse failure, never U+FFFD in a field. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * One extractor's body, held to the rules every extractor keeps: the bytes
 * decoded strictly, the file's standing taken from where it is (`allowed`; a
 * path the allow-list does not name is a `mention`, which cannot vouch), the
 * findings capped, and nothing thrown that carries a message of anyone's but
 * the engine's.
 */
const guarded =
  (read: (facts: FileFacts) => readonly Finding[] | ParseFailure) =>
  (path: string, bytes: Buffer): Extracted => {
    try {
      let text: string
      try {
        text = UTF8.decode(bytes)
      } catch {
        return { outcome: 'parse-failure', why: 'not-utf8' }
      }
      const fileSha256 = createHash('sha256').update(bytes).digest('hex')
      const found = read({ path, text, fileSha256, standing: allowed(path)?.standing ?? 'mention' })
      if (typeof found === 'string') return { outcome: 'parse-failure', why: found }
      if (found.length > DISCOVERY_LIMITS.maxFindingsPerFile) return { outcome: 'over-finding-cap', count: found.length }
      return { outcome: 'read', findings: Object.freeze([...found]) }
    } catch {
      // What a parser throws is caught inside the extractor and named there;
      // what reaches here is an engine bug, and its message — which might
      // quote a value — is replaced by one that holds no byte of the file.
      // `discover` makes it the file's reason, and the re-read supports
      // nothing from it.
      throw new Error('an extractor failed on a file, an engine bug')
    }
  }

/** A record over `ExtractorName`, so an extractor added to the allow-list without one does not compile. */
export const EXTRACTORS: { readonly [E in ExtractorName]: (path: string, bytes: Buffer) => Extracted } = Object.freeze({
  'env-file': guarded(envFile),
  npm: guarded(npm),
  k8s: guarded(k8s),
})

/**
 * The same table as the re-read takes it (`verifyFinding`'s `extract`): a
 * file that no longer parses, or is over the finding cap, says nothing, so
 * no finding of it is supported.
 */
export function findingsOf(table: typeof EXTRACTORS): { readonly [E in ExtractorName]: Extract } {
  const of =
    (extractor: ExtractorName): Extract =>
    (path, bytes) => {
      const extracted = table[extractor](path, bytes)
      return extracted.outcome === 'read' ? extracted.findings : []
    }
  return { 'env-file': of('env-file'), npm: of('npm'), k8s: of('k8s') }
}

/** The words for a parse failure, which the report prints beside the file. */
export function parseFailureReason(why: ParseFailure): string {
  switch (why) {
    case 'not-json':
      return 'not plain JSON'
    case 'duplicate-key':
      return 'a key written twice'
    case 'not-an-object':
      return 'not a JSON object'
    case 'too-deep':
      return `nested deeper than ${String(DISCOVERY_LIMITS.maxJsonDepth)}`
    case 'not-utf8':
      return 'not valid UTF-8'
    case 'unclosed-quote':
      return 'a quote that never closes'
    case 'not-yaml':
      return 'not a YAML stream this version reads whole'
    default: {
      const _exhaustive: never = why
      return _exhaustive
    }
  }
}
