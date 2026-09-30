import {
  RELATION_LIMITS,
  reachedBy,
  rightsOn,
  type Meeting,
  type Named,
  type RelationResult,
  type RelationRow,
  type Step,
} from '../../context/graph/relations.js'
import type { OrganisationField } from '../../context/graph/entity-graph.js'
import {
  ORGANISATION_RELATIONS,
  OWN_RELATIONS,
  type OrganisationRelation,
  type OwnRelation,
  type Relation,
} from '../../core/schemas/query.js'
import { boundOf } from './catalogue-read.js'
import { ENTITY_LIMITS, NOT_LOADED, NOWHERE, nowhere } from './entity.js'
import { oneLine } from './plain.js'
import { renderTable } from './table.js'

/**
 * The relations of one entity as a person reads them: its reference, then one
 * section per relation — a title with how many rows the walk found, a table,
 * and under it every bound the walk reached, said rather than left for the
 * reader to assume the list complete. `relations` prints it, and so does
 * `ask` when the model chose a `relation` answer: one renderer, so the
 * command and the answer cannot disagree about a path. Only the way further
 * differs: `--depth` on the command line, and the whole command under an
 * answer, where `--depth` is not an option.
 *
 * Every string on it came from a repository file, a reference included — one
 * declared nowhere is kept as the file wrote it — so each goes through
 * `oneLine`, as on `show`'s card.
 */

const shown = (text: string): string => oneLine(text, ENTITY_LIMITS.text)

/** A relation read from one node alone: every one but `between`. */
type OneEnd = OwnRelation | OrganisationRelation

/** What each relation is called on its section's title. */
const TITLES: Record<Relation | OrganisationRelation, string> = {
  consumes: 'consumes',
  'consumed-by': 'consumed by',
  'depends-on': 'depends on',
  impacts: 'impacts',
  provides: 'provides',
  'provided-by': 'provided by',
  between: 'paths to',
  owns: 'owns',
  'owned-by': 'owned by',
  'member-of': 'member of',
  'has-member': 'has members',
  'part-of': 'part of',
  'has-part': 'has parts',
}

/**
 * Between two steps of a path. An arrow always points from what depends to
 * what it depends on, so a path read from the entity asked about runs
 * against the arrows when the relation walks toward what needs it. Providing
 * is not depending (design 4.1), so it is said in words. In the organisation
 * an arrow points the same way, from what is held — an owned node, a member,
 * a part — to what holds it.
 */
const SEPARATORS: Record<OneEnd, string> = {
  consumes: ' → ',
  'depends-on': ' → ',
  'consumed-by': ' ← ',
  impacts: ' ← ',
  provides: ' provides ',
  'provided-by': ' is provided by ',
  owns: ' ← ',
  'owned-by': ' → ',
  'member-of': ' → ',
  'has-member': ' ← ',
  'part-of': ' → ',
  'has-part': ' ← ',
}

/** The organisation's relations, whose rows are nodes: a Group, a User, a System are no entities. */
const ORGANISATION: ReadonlySet<string> = new Set(ORGANISATION_RELATIONS)

/** What a field of the organisation is called in a sentence about the node that declares it. */
const FIELD_WORDS: Record<OrganisationField, string> = {
  owner: 'owner',
  system: 'system',
  domain: 'domain',
  subdomainOf: 'parent domain',
  memberOf: 'group',
  members: 'member',
  parent: 'parent',
  children: 'child',
}

/** What a reference ending a path is, beside it: declared nowhere, or in the catalogue and not read. */
export const SET_ASIDE = 'in the catalogue, not read'

/**
 * The order the overview says them in: what it reaches, who reaches it, then
 * the rest — `RELATIONS`' own order, so there is one list to keep.
 */
export const OVERVIEW_ORDER: readonly OwnRelation[] = OWN_RELATIONS

/**
 * Where the block is read, which decides how a bound says the way further:
 * `command`, printed by `idpa relations`, names the flag; `answer`, printed
 * under an answer to a question, names the whole command.
 */
export type Road = 'command' | 'answer'

/** A step by its name: the path is read beside the full references of the table. */
const nameOf = (step: Step): string => {
  const slash = step.ref.lastIndexOf('/')
  return shown(slash === -1 ? step.ref.slice(step.ref.indexOf(':') + 1) : step.ref.slice(slash + 1))
}

/**
 * What a right grants, as it says it: its level, `(undeclared)` for a right
 * whose type states one and that states none, `-` for a right whose type
 * states none — a network flow is opened or it is not (design 4.1).
 */
const grantOf = (step: Step): string => {
  if (step.right === undefined) return ''
  if (!step.right.levelled) return step.right.level ?? '-'
  return step.right.level ?? '(undeclared)'
}

/** A step on a path: its name, and the level a right states when it states one. */
const stepText = (step: Step): string =>
  step.right?.level === undefined ? nameOf(step) : `${nameOf(step)} (${step.right.level})`

/**
 * A path, and what its last step is called when it names nothing (`said`,
 * `NOWHERE` by default), names a document set aside (`SET_ASIDE`), or names
 * what a bound left out (`NOT_LOADED`).
 */
function pathText(row: RelationRow, separator: string, said: string): string {
  const last = reachedBy(row)
  const path = row.steps.map(stepText).join(separator)
  if (last.nowhere !== undefined) return `${path} — ${nowhere(last.nowhere, said)}`
  if (last.notLoaded === true) return `${path} — ${NOT_LOADED}`
  return last.setAside === true ? `${path} — ${SET_ASIDE}` : path
}

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `${by}${line}`))
    .join('\n')

/**
 * A row's access, and the rights it runs through. The level is the grant of
 * the right next to the entity the row names — the one over the object a
 * consumer reaches, or the one naming the consumer an object is reached by —
 * and nothing past it: a right over a database grants nothing on its host.
 * Each right is named with its own environment, being authorised in dev
 * granting nothing in prod (design 4.1).
 */
function accessCells(row: RelationRow): [string, string] {
  const rights = rightsOn(row)
  if (rights.length === 0) return ['', '(no right)']
  const next = row.steps[row.steps.length - 2] as Step
  return [
    next.right === undefined ? '' : grantOf(next),
    rights.map((right) => `${shown(right.ref)} (${shown(right.env ?? 'no env')})`).join(', '),
  ]
}

function table(result: RelationResult, said: string): string {
  const relation = result.relation as OneEnd
  const separator = SEPARATORS[relation]
  // Of a consumer and of what it reaches, the access is the answer: the level
  // and the right it comes from. ENV is always the entity's own.
  const access = relation === 'consumes' || relation === 'consumed-by'
  const headers = access
    ? ['ENTITY', 'TYPE', 'ENV', 'ACCESS', 'VIA', 'DEPTH', 'PATH']
    : [ORGANISATION.has(relation) ? 'NODE' : 'ENTITY', 'TYPE', 'ENV', 'DEPTH', 'PATH']
  const rows = result.rows.map((row) => {
    const reached = reachedBy(row)
    const head = [shown(reached.ref), shown(reached.type ?? '-'), shown(reached.env ?? '-')]
    const tail = [String(row.steps.length - 1), pathText(row, separator, said)]
    return access ? [...head, ...accessCells(row), ...tail] : [...head, ...tail]
  })
  return renderTable(headers, rows)
}

/** Every step of a path or two, once each, with its type, environment and level. */
function stepTable(steps: readonly Step[]): string {
  const once = [...new Map(steps.map((step) => [step.ref, step])).values()]
  return renderTable(
    ['STEP', 'TYPE', 'ENV', 'ACCESS'],
    once.map((step) => [
      shown(step.ref),
      shown(step.type ?? '-'),
      shown(step.env ?? '-'),
      grantOf(step),
    ]),
  )
}

/** One path of `between`, and every step on it with its type, environment and level. */
function pathBlock(row: RelationRow, said: string): string {
  const arrow = row.backward === true ? ' ← ' : ' → '
  return [pathText(row, arrow, said), indent(stepTable(row.steps), '  ')].join('\n')
}

/**
 * An entity both ends of `between` reach: its reference, the path to it from
 * each end, and every step of the two with its type, environment and level.
 */
function meetingBlock(meeting: Meeting, said: string): string {
  const [mine, theirs] = meeting.paths
  const arrow = meeting.relation === 'depends-on' ? ' → ' : ' ← '
  return [
    shown(reachedBy(mine).ref),
    indent([pathText(mine, arrow, said), pathText(theirs, arrow, said)].join('\n'), '  '),
    indent(stepTable([...mine.steps, ...theirs.steps]), '  '),
  ].join('\n')
}

/** The command that reads this relation again: the way further, under an answer. */
function commandOf(result: RelationResult): string {
  const subject = shown(result.subject.ref)
  return result.relation === 'between' && result.to !== undefined
    ? `idpa relations ${subject} --to ${shown(result.to.ref)}`
    : `idpa relations ${subject} --${result.relation}`
}

/** Every bound the walk reached, and every cycle it did not follow. Never silent. */
function notes(result: RelationResult, road: Road): string[] {
  const lines: string[] = []
  const cut = result.total - result.rows.length
  if (cut > 0) lines.push(`${String(cut)} more not shown`)
  const further = (flag: string): string =>
    road === 'command' ? flag : `${commandOf(result)} ${flag}`
  if (result.stopped) {
    if (result.relation === 'between') {
      lines.push(
        `paths longer than ${String(result.depth)} steps were not searched; ` +
          `${further('--depth <n>')} searches further`,
      )
    } else if (
      result.relation === 'consumes' &&
      result.depth === RELATION_LIMITS.consumesDepth
    ) {
      // Stopping at the object each right is over is what `consumes` means;
      // what those objects depend on — a host, as a rule — is one hop away.
      lines.push(
        `what these depend on is not listed; ${further(`--depth ${String(result.depth + 1)}`)} follows it`,
      )
    } else {
      lines.push(`stopped at depth ${String(result.depth)}; ${further('--depth <n>')} goes further`)
    }
  }
  if (result.exhausted === true) {
    lines.push(
      `the search stopped after ${String(RELATION_LIMITS.paths)} steps; there may be more paths`,
    )
  }
  const separator =
    result.relation === 'between' || SEPARATORS[result.relation] !== ' ← ' ? ' → ' : ' ← '
  for (const cycle of result.cycles.slice(0, RELATION_LIMITS.cycles)) {
    const names = cycle.map((ref) => nameOf({ ref }))
    lines.push(`a cycle, not followed: ${names.join(separator)}`)
  }
  const more = result.cycles.length - RELATION_LIMITS.cycles
  if (more > 0) lines.push(`+${String(more)} more cycles`)
  return lines
}

/** A section: its title and count, its body, and the lines under it. */
const section = (title: string, total: number, body: string, under: readonly string[]): string =>
  [`${title} (${String(total)})`, indent(body, '  '), ...under.map((line) => `  ${line}`)].join(
    '\n',
  )

/** How many a bounded list cut, said under it. */
const cutOf = (list: { rows: readonly unknown[]; total: number }): string[] =>
  list.total > list.rows.length ? [`${String(list.total - list.rows.length)} more not shown`] : []

/**
 * `between`: the paths linking the two, each a declared dependency of one on
 * the other; where there is none, the nearest entities both reach; and apart
 * from both, a declaration naming nothing that carries one end's name. A near
 * miss is counted apart and relates nothing: which entity its file meant is
 * the reader's to decide (design 4.1).
 */
function betweenSections(result: RelationResult, road: Road, said: string): string[] {
  const title = `${TITLES.between} ${shown(result.to?.ref ?? '')}`
  const body =
    result.rows.length === 0
      ? 'no path where one depends on the other'
      : result.rows.map((row) => pathBlock(row, said)).join('\n\n')
  const shared = result.shared?.rows ?? []
  const groups = (
    [
      ['depends-on', 'both depend on'],
      ['impacts', 'depend on both'],
    ] as const
  ).flatMap(([relation, named]) => {
    const rows = shared.filter((meeting) => meeting.relation === relation)
    return rows.length === 0 ? [] : [{ named, rows }]
  })
  // The row bound applies to the two lists together; what it cut is said
  // under the last of them.
  const cut = result.shared === undefined ? [] : cutOf(result.shared)
  const near = result.nearMisses
  return [
    section(title, result.total, body, notes(result, road)),
    ...groups.map(({ named, rows }, index) =>
      section(
        named,
        rows.length,
        rows.map((meeting) => meetingBlock(meeting, said)).join('\n\n'),
        index === groups.length - 1 ? cut : [],
      ),
    ),
    ...(near === undefined
      ? []
      : [
          section(
            `near misses, ${said}`,
            near.total,
            near.rows.map((row) => pathBlock(row, said)).join('\n\n'),
            cutOf(near),
          ),
        ]),
  ]
}

/**
 * Why a reference the subject declares is read as a name and not judged: the
 * catalogue's read of its kind stopped at a bound, the source holds no node
 * of its kind, or holds some that are not the whole organisation — a
 * declarations repository keeps the Group files it happens to keep.
 */
function whyNamed(name: Named): string {
  if (name.kind === undefined) return 'this source holds nothing of that name'
  if (name.bound !== undefined) return `${name.kind}s past ${boundOf(name.bound)} were not loaded`
  return name.held
    ? `a declarations repository's ${name.kind} files are not read as the whole organisation`
    : `this source holds no ${name.kind}`
}

/**
 * An empty relation: "none", or, when what the subject declares for the first
 * hop is only read as a name, one line for each saying so — "none" alone
 * would read as "declares nothing" of a file that names an owner.
 */
function emptyBody(result: RelationResult): string {
  const named = result.named ?? []
  if (named.length === 0) return 'none'
  const subject = nameOf(result.subject)
  return named
    .map(
      (name) =>
        `none: ${shown(name.to)}, the ${FIELD_WORDS[name.field]} ${subject} names, ` +
        `is read as a name here: ${whyNamed(name)}`,
    )
    .join('\n')
}

/** A relation's sections: one for a relation read from one end, several for `between`. */
function sections(result: RelationResult, road: Road, said: string): string[] {
  if (result.relation === 'between') return betweenSections(result, road, said)
  const body = result.rows.length === 0 ? emptyBody(result) : table(result, said)
  return [section(TITLES[result.relation], result.total, body, notes(result, road))]
}

/**
 * Whether a relation holds something: a row, or for `between` an entity both
 * ends reach. A near miss does not: it reaches nothing.
 */
export const holds = (result: RelationResult): boolean =>
  result.total > 0 || (result.shared?.total ?? 0) > 0

/**
 * One relation of one entity: its reference, then that relation's sections.
 * `said` is what a reference naming nothing is called (`NOWHERE`).
 */
export function renderRelation(result: RelationResult, road: Road = 'command', said: string = NOWHERE): string {
  return [shown(result.subject.ref), ...sections(result, road, said)].join('\n\n')
}

/**
 * Every relation of one node that holds something — an entity's in
 * `OVERVIEW_ORDER`, an organisation node's in `ORGANISATION_RELATIONS`' —
 * or the one line that says none does. An organisation relation whose first
 * hop is only read as a name is said too, in its one line (`emptyBody`):
 * "no relation declared" is false of a User whose file names a Group. An
 * entity's relations never carry a name, so its overview is what it was.
 */
export function renderRelationsOverview(
  subject: Step,
  results: readonly RelationResult[],
  road: Road = 'command',
  said: string = NOWHERE,
): string {
  const held = results.filter((result) => holds(result) || (result.named ?? []).length > 0)
  if (held.length === 0) return `${shown(subject.ref)}\n\nno relation declared`
  return [shown(subject.ref), ...held.flatMap((result) => sections(result, road, said))].join('\n\n')
}
