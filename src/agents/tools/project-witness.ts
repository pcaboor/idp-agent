import { echoes, fold } from '../../core/plan/echoes.js'
import type { ProjectFacts, ReadFile } from './project-tools.js'

/**
 * A value the Inspector reports, held to the files it read.
 *
 * The Analyst's answer carries only references a tool returned (ADR-0007), and
 * the sentences around it only what was read (ADR-0008). The Inspector's report
 * had no such check: on 2026-10-02 a model passed a `package.json` it wrote
 * itself as `read_file`'s arguments, was refused, and reported that manifest's
 * name, runtime and dependencies — and the Architect was sent them as facts.
 * Here, a value is kept only where a file `read_file` returned to the model,
 * in a turn before the report, states it by its field's rule. Anything else
 * becomes `{ unknown: <the engine's reason> }`, and is said (`unwitnessed`).
 *
 * What this gives: a kept value is one some file the model was handed says, as
 * a whole token, where the rule asks for it. What it does NOT give: that the
 * file is right, or that it is about this field — the keyed rule reads a line,
 * not a format. A witnessed fact is "some file says so", never "true"; the
 * diff and the merge are where a person judges it. Nor does it hold the reason
 * a model writes for a field it marks unknown: that is not a value, and no
 * other model reads it — the Architect is sent the engine's fixed reason for
 * that field (`FACT_UNKNOWN`, `architect.ts`), whatever the report said.
 *
 * Every test is `echoes`, the signature's own: NFKC, case-folded, invisible
 * characters removed, a change of script ending a token. Since a kept value is
 * the model's bytes and not the file's, a value that folding would change in
 * anything but its case is stated by no file (`plain`). No word of any
 * language is read: the keys are field names of file formats, and a file that
 * says a value in prose is no witness, so the value is asked — the safe side.
 */

/**
 * How a file states a field's value.
 *
 *   token      some file holds the value as a whole token
 *   keyed      some LINE of a file holds one of the field's keys and the value,
 *              each as a whole token
 *   reference  some file holds the reference in full, or as `kind:name` when
 *              its namespace is `default`
 */
export type WitnessRule = 'token' | 'keyed' | 'reference'

type Field = keyof ProjectFacts

/**
 * One rule per field the report carries: a field added to the schema without
 * one is a compile error.
 *
 * `name`, `type` and `lifecycle` are keyed because their values are ordinary
 * words — "service", "production" — that a README or `NODE_ENV=production`
 * holds without saying anything about a catalogue entry. `owner` is a
 * reference because a bare `owner: platform` is turned into one only by
 * Backstage's defaults, and that is an inference.
 */
export const WITNESS_RULES: { readonly [K in Field]: WitnessRule } = {
  name: 'keyed',
  type: 'keyed',
  lifecycle: 'keyed',
  runtime: 'token',
  owner: 'reference',
  forgeHandle: 'token',
}

/**
 * The keys of each keyed field: field names of file formats, never words of a
 * language. `name` is what `package.json`, `Cargo.toml`, `pyproject.toml` and a
 * catalog-info name a package by, `module` what `go.mod` does and `artifactId`
 * what `pom.xml` does; `type` and `lifecycle` are Backstage's.
 *
 * Known limits, each pinned by a row of `inspector.test.ts`: any line holding
 * the key states its value — a workflow's `name: ci`, `"type": "module"`, an
 * environment variable `LIFECYCLE=production` — and a file of one line is one
 * line, so a minified manifest is a whole-file test. Tighter is a parser per
 * format, which is stage 8's extractors.
 */
export const WITNESS_KEYS: {
  readonly name: readonly string[]
  readonly type: readonly string[]
  readonly lifecycle: readonly string[]
} = {
  name: ['name', 'module', 'artifactId'],
  type: ['type'],
  lifecycle: ['lifecycle'],
}

/** `field` is the field of the report the value was withdrawn from: `name`, `forgeHandle`. */
export interface Unwitnessed {
  readonly field: string
  readonly value: string
  readonly reason: string
}

/** The words a reason names a field by: never the value, which is the model's. */
const LABELS: { readonly [K in Field]: string } = {
  name: 'name',
  type: 'type',
  lifecycle: 'lifecycle',
  runtime: 'runtime',
  owner: 'owner',
  forgeHandle: 'forge handle',
}

/**
 * The reasons the engine writes into an unknown. Fixed strings, so the bytes
 * the Architect is sent are deterministic, and none quotes the value it
 * withdraws: quoting it would put the invention back in front of the model
 * that is drafting. The value goes to stderr and the trace, for a person.
 */
export const unstatedReason = (field: Field): string =>
  `no file the Inspector read states the ${LABELS[field]} it reported`

/**
 * Every field's reason when the inspection ended with no report. The model's
 * words, when it said any, go on the `refused` event alone: they are a person's
 * to read, and handed on as a reason they would reach the Architect as facts
 * nobody read.
 */
export const NO_REPORT =
  'the inspection ended with no report, so nothing about this repository was established'

/** Every way a line ends, so the keyed rule never reads two lines as one. */
const LINE = /\r\n|[\n\r\u2028\u2029]/u

const DEFAULT_NAMESPACE = 'default'

/** The spellings of a reference a file may state it by: in full, and `kind:name` in the default namespace. */
function spellings(reference: string): string[] {
  const colon = reference.indexOf(':')
  const slash = reference.indexOf('/', colon + 1)
  if (colon === -1 || slash === -1) return [reference]
  const namespace = reference.slice(colon + 1, slash)
  return namespace === DEFAULT_NAMESPACE
    ? [reference, `${reference.slice(0, colon)}:${reference.slice(slash + 1)}`]
    : [reference]
}

const CONTROL = /[\p{Cc}\p{Cf}]/u

/**
 * A value whose bytes are what a person reading them sees: no control or
 * format character, nothing NFKC rewrites, and nothing `fold` takes out or
 * turns into another character but its case.
 *
 * `echoes` compares folded, and the value kept is the model's as reported: so
 * `serv\u00ADice` with a soft hyphen, `\uFF53\uFF45\uFF52\uFF56\uFF49\uFF43\uFF45` full-width or `node\u2010js`
 * with U+2010 would be found in `type: service` or `node-js`, and the diff
 * would then write bytes no file holds, in a difference no reviewer can see.
 * Such a value is stated by no file, even one holding the same bytes: it is
 * asked instead, the safe side. Case is the one folding left, and a value in
 * another case is kept (a pinned limit), because the diff shows it as it is.
 */
const plain = (value: string): boolean =>
  !CONTROL.test(value) && value.normalize('NFKC') === value && fold(value) === value.toLowerCase()

function states(
  rule: WitnessRule,
  keys: readonly string[],
  value: string,
  read: readonly ReadFile[],
): boolean {
  if (!plain(value)) return false
  switch (rule) {
    case 'token':
      return read.some((file) => echoes(file.text, value))
    case 'keyed':
      return read.some((file) =>
        file.text
          .split(LINE)
          .some((line) => keys.some((key) => echoes(line, key)) && echoes(line, value)),
      )
    case 'reference': {
      const forms = spellings(value)
      return read.some((file) => forms.some((form) => echoes(file.text, form)))
    }
    default: {
      const exhaustive: never = rule
      return exhaustive
    }
  }
}

const keysOf = (field: Field): readonly string[] =>
  field === 'name' || field === 'type' || field === 'lifecycle' ? WITNESS_KEYS[field] : []

const FIELDS: readonly Field[] = ['name', 'type', 'lifecycle', 'runtime', 'owner', 'forgeHandle']

/**
 * The report, with every value no file in `read` states withdrawn, and what was
 * withdrawn. A value the model already marked unknown is passed on as written,
 * and its reason reaches no model (`formatFacts`, `architect.ts`).
 */
export function witnessFacts(
  facts: ProjectFacts,
  read: readonly ReadFile[],
): { readonly facts: ProjectFacts; readonly unwitnessed: readonly Unwitnessed[] } {
  const unwitnessed: Unwitnessed[] = []
  const held: ProjectFacts = { ...facts }

  for (const field of FIELDS) {
    const value = facts[field]
    if (typeof value !== 'string') continue
    if (states(WITNESS_RULES[field], keysOf(field), value, read)) continue
    const reason = unstatedReason(field)
    held[field] = { unknown: reason }
    unwitnessed.push({ field, value, reason })
  }

  return { facts: unwitnessed.length === 0 ? facts : held, unwitnessed }
}
