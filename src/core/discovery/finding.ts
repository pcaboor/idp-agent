import { createHash } from 'node:crypto'
import { CONNECTION_FORMS, composeConnection, type Connection } from './connection.js'
import {
  credentialShaped,
  isHost,
  isHttpUrl,
  isIdentifier,
  isPackageName,
  isPort,
  isScheme,
  isVariable,
} from './grammar.js'
import { DISCOVERY_LIMITS } from './limits.js'
import { RULES, type RuleName } from './rules.js'

/**
 * A finding: what a configuration file of the service's repository states,
 * as the engine read it (stage 8 brief § 5). An engine reached, a package's
 * name, or a value this version could not, or would not, read.
 *
 * It has NO FIELD A SECRET COULD SIT IN. Every field it keeps is held to a
 * closed grammar and to the credential shapes when it is made, and a value
 * that fails either is kept as `unparsed` or `withheld` with its file and
 * line only. `shown` is composed from the kept fields, never cut from the
 * line. And `mintFinding` is the only way to make one: a spread copy, a cast
 * or a parsed JSON is not minted (`isMinted`), as a `Cleared` is not
 * (`core/plan/clear.ts`).
 *
 * In slice 1 nothing vouches with a finding and no model sees one: an
 * architecture rule keeps `core/discovery/` out of everything `agents/`
 * reaches.
 */

/** How far a finding can vouch, the first that holds of these, in this order (plan, 1.2 and 1.4). */
export const STANDINGS = ['evidence', 'sample', 'mention', 'placeholder', 'local', 'claimed'] as const
export type Standing = (typeof STANDINGS)[number]

export const ENGINES = [
  'postgres',
  'mysql',
  'mariadb',
  'mssql',
  'oracle',
  'mongodb',
  'redis',
  'amqp',
  'kafka',
  'http',
] as const
export type Engine = (typeof ENGINES)[number]

/** What a finding says: an engine reached, a package's name, or a value this version could not, or would not, read. */
export type FindingKind = Engine | 'package-name' | 'unparsed' | 'withheld'

export interface HostPort {
  readonly host: string
  readonly port?: number
}

/** Every field a finding may keep, each held to its grammar. None can hold a secret. */
export interface Fields {
  readonly scheme?: string
  /** At most eight. */
  readonly hosts?: readonly HostPort[]
  readonly database?: string
  readonly account?: string
  /** http(s): the origin only, never a path. */
  readonly url?: string
  /** The env-file key. */
  readonly variable?: string
  /** npm.name */
  readonly name?: string
  /** npm.dependency */
  readonly package?: string
}

export interface Finding {
  /** sha256, hex, of [rule, ruleVersion, path, start, end, fields, fileSha256]. */
  readonly id: string
  readonly rule: RuleName
  readonly ruleVersion: number
  /** Repo-relative, POSIX. */
  readonly path: string
  /** 1-based, inclusive. */
  readonly lines: readonly [number, number]
  readonly fileSha256: string
  readonly kind: FindingKind
  readonly standing: Standing
  readonly fields: Fields
  /** Composed from `fields` alone: `•••` where a password or a userinfo was, `…` where options were dropped. */
  readonly shown: string
}

/** What an extractor hands `mintFinding`: candidates, not yet held to anything. */
export interface Draft {
  readonly rule: RuleName
  readonly path: string
  readonly lines: readonly [number, number]
  readonly fileSha256: string
  readonly standing: Standing
  readonly variable?: string
  readonly value:
    | { readonly connection: Connection }
    | { readonly name: string }
    | { readonly package: string; readonly engine: Engine }
}

/**
 * Every finding this module minted, and nothing else. A `WeakSet` holds
 * identities no other module can add to, and lets go of them with the value.
 */
const minted = new WeakSet<object>()

/** Keys sorted at every depth, so one content has one text whatever order it was built in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, canonical(inner)]),
  )
}

/**
 * A finding's name, by its content: the sha256 of the canonical JSON of its
 * rule, the rule's version, its path, its span, its fields and its file's
 * hash. Stable across the rounds of an ask loop and across recordings;
 * `shown`, `kind` and `standing` follow from those and are left out.
 */
export function findingId(
  finding: Pick<Finding, 'rule' | 'ruleVersion' | 'path' | 'lines' | 'fields' | 'fileSha256'>,
): string {
  const [start, end] = finding.lines
  const content = [finding.rule, finding.ruleVersion, finding.path, start, end, finding.fields, finding.fileSha256]
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex')
}

/** Did `mintFinding` make exactly this object, and does its name still say what it holds? */
export const isMinted = (value: unknown): value is Finding =>
  typeof value === 'object' && value !== null && minted.has(value) && findingId(value as Finding) === (value as Finding).id

/** Why a field is not kept: outside its grammar, or shaped like a credential. */
type Refusal = 'unparsed' | 'withheld'

/** The grammar each field is held to. A record, so a field added to `Fields` without one does not compile. */
const GRAMMARS: { readonly [K in keyof Required<Fields>]: (value: NonNullable<Fields[K]>) => boolean } = {
  scheme: isScheme,
  hosts: (hosts) =>
    hosts.length <= DISCOVERY_LIMITS.maxHosts &&
    hosts.every((entry) => isHost(entry.host) && (entry.port === undefined || isPort(entry.port))),
  database: isIdentifier,
  account: isIdentifier,
  url: isHttpUrl,
  variable: isVariable,
  name: isPackageName,
  package: isPackageName,
}

/** Whether a value is a list of hosts, each a string and a port or none, and nothing it could be read as else. */
const isHostList = (value: unknown): value is readonly HostPort[] =>
  Array.isArray(value) &&
  value.every(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as HostPort).host === 'string' &&
      ((entry as HostPort).port === undefined || typeof (entry as HostPort).port === 'number'),
  )

/** Every string a set of fields holds. */
const stringsOf = (fields: Fields): string[] =>
  Object.values(fields).flatMap((value: Fields[keyof Fields]) =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.map((entry: HostPort) => entry.host) : [],
  )

/** Whether fields made from a candidate may be kept: each inside its grammar, then none shaped like a credential. */
function refusalOf(fields: Fields): Refusal | undefined {
  for (const [key, value] of Object.entries(fields) as [keyof Fields, unknown][]) {
    if (value === undefined) continue
    // The type is the caller's word, and a draft is not taken at its word: a
    // number where a name goes, or a host that is no object, is outside its
    // grammar before any grammar is run.
    const typed = key === 'hosts' ? isHostList(value) : typeof value === 'string'
    const holds = GRAMMARS[key] as (value: unknown) => boolean
    if (!typed || !holds(value)) return 'unparsed'
  }
  return stringsOf(fields).some(credentialShaped) ? 'withheld' : undefined
}

/** The env-file key, kept only inside its grammar and shaped like no credential. */
const keptVariable = (variable: string | undefined): string | undefined =>
  variable !== undefined && isVariable(variable) && !credentialShaped(variable) ? variable : undefined

const ELIDED = '…'

/** What a finding is made of, before it is named and frozen. */
interface Made {
  readonly kind: FindingKind
  readonly fields: Fields
  readonly shown: string
  /** Its value names another value: configured outside this repository. */
  readonly placeholder?: true
}

/** An engine bug, never repository data: the message names the rule, and no byte the repository wrote. */
const bug = (rule: string, what: string): Error => new Error(`${rule}: ${what}, an engine bug`)

const isEngine = (value: unknown): value is Engine => (ENGINES as readonly unknown[]).includes(value)
const isForm = (value: unknown): boolean => (CONNECTION_FORMS as readonly unknown[]).includes(value)

/**
 * An `env-file.url` candidate, by what the parser made of the value. The
 * connection is held again here, not taken at the parser's word: an engine or
 * a form nobody named is an engine bug, and of each host only its name and
 * its port are read, so nothing else an object carries reaches a finding.
 */
function fromConnection(connection: Connection, variable: string | undefined): Made {
  const named: Fields = variable === undefined ? {} : { variable }
  const prefix = variable === undefined ? '' : `${variable}=`
  const refused = (kind: Refusal): Made => ({ kind, fields: named, shown: `${prefix}${ELIDED}` })
  switch (connection.outcome) {
    case 'parsed': {
      if (!isEngine(connection.engine) || !isForm(connection.form)) {
        throw bug('env-file.url', 'a connection of an engine or a form nobody named')
      }
      if (!isHostList(connection.hosts)) return refused('unparsed')
      const hosts = connection.hosts.map(({ host, port }) => (port === undefined ? { host } : { host, port }))
      const fields: Fields = {
        scheme: connection.scheme,
        hosts,
        ...(connection.database === undefined ? {} : { database: connection.database }),
        ...(connection.user === undefined ? {} : { account: connection.user }),
        ...(connection.url === undefined ? {} : { url: connection.url }),
        ...named,
      }
      const refusal = refusalOf(fields)
      if (refusal !== undefined) return refused(refusal)
      return { kind: connection.engine, fields, shown: `${prefix}${composeConnection({ ...connection, hosts })}` }
    }
    case 'placeholder': {
      if (!isEngine(connection.engine) || !isForm(connection.form)) {
        throw bug('env-file.url', 'a connection of an engine or a form nobody named')
      }
      const fields: Fields = { scheme: connection.scheme, ...named }
      if (refusalOf(fields) !== undefined) return refused('unparsed')
      const written =
        connection.form === 'url'
          ? `${connection.scheme}://${ELIDED}`
          : connection.form === 'jdbc'
            ? `${connection.scheme}:${ELIDED}`
            : ELIDED
      return { kind: connection.engine, fields, shown: `${prefix}${written}`, placeholder: true }
    }
    case 'unparsed':
      return refused('unparsed')
    case 'withheld':
      return refused('withheld')
    default: {
      const _exhaustive: never = connection
      throw bug('env-file.url', `a connection whose outcome nobody named (${typeof _exhaustive})`)
    }
  }
}

/**
 * The only way to make a finding: every field held to its grammar and to the
 * credential shapes, `shown` composed from what was kept, the whole named by
 * its content, frozen and registered. A field outside its grammar makes it
 * `unparsed`, a credential-shaped one `withheld`, each with its file, its
 * line and its `variable` when that passes both. Throws only on an engine
 * bug: a value its rule does not carry, a field the rule does not list, a
 * span out of order.
 */
export function mintFinding(draft: Draft): Finding {
  const rule = RULES[draft.rule]
  const [start, end] = draft.lines
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw bug(draft.rule, 'a span out of order')
  }
  const carries: ReadonlySet<string> = new Set(rule.fields)
  if (draft.variable !== undefined && !carries.has('variable')) throw bug(draft.rule, 'a variable it does not carry')
  const variable = keptVariable(draft.variable)
  const value = draft.value

  let made: Made
  // `Draft['value']` has no tag of its own; its rule is the closed union that says which it must be.
  switch (draft.rule) {
    case 'env-file.url': {
      if (!('connection' in value)) throw bug(draft.rule, 'a value that is not a connection')
      made = fromConnection(value.connection, variable)
      break
    }
    case 'npm.name': {
      if (!('name' in value) || 'package' in value) throw bug(draft.rule, 'a value that is not a name')
      const refusal = refusalOf({ name: value.name })
      made =
        refusal === undefined
          ? { kind: 'package-name', fields: { name: value.name }, shown: `"name": "${value.name}"` }
          : { kind: refusal, fields: {}, shown: `"name": ${ELIDED}` }
      break
    }
    case 'npm.dependency': {
      if (!('package' in value)) throw bug(draft.rule, 'a value that is not a package')
      if (!isEngine(value.engine)) throw bug(draft.rule, 'a package of an engine nobody named')
      const refusal = refusalOf({ package: value.package })
      made =
        refusal === undefined
          ? { kind: value.engine, fields: { package: value.package }, shown: `"${value.package}": ${ELIDED}` }
          : { kind: refusal, fields: {}, shown: ELIDED }
      break
    }
    default: {
      const _exhaustive: never = draft.rule
      throw bug(String(_exhaustive), 'a rule nobody wrote')
    }
  }
  for (const key of Object.keys(made.fields)) {
    if (!carries.has(key)) throw bug(draft.rule, `a field it does not carry (${key})`)
  }

  const standing: Standing =
    draft.standing === 'mention' ? 'mention' : made.placeholder === true ? 'placeholder' : draft.standing
  const fields = frozenFields(made.fields)
  const lines = Object.freeze([start, end] as const)
  const named = { rule: draft.rule, ruleVersion: rule.version, path: draft.path, lines, fields, fileSha256: draft.fileSha256 }
  const finding: Finding = Object.freeze({
    id: findingId(named),
    rule: draft.rule,
    ruleVersion: rule.version,
    path: draft.path,
    lines,
    fileSha256: draft.fileSha256,
    kind: made.kind,
    standing,
    fields,
    shown: made.shown,
  })
  minted.add(finding)
  return finding
}

/** A copy of the fields, frozen to the last host, so nothing a finding holds can change after it is named. */
function frozenFields(fields: Fields): Fields {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(fields).map(([key, value]: [string, Fields[keyof Fields]]) => [
        key,
        Array.isArray(value) ? Object.freeze(value.map((entry: HostPort) => Object.freeze({ ...entry }))) : value,
      ]),
    ),
  )
}
