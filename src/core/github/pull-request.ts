import { coverageHeading, coverageSections, coverageSentence, type Coverage } from '../discovery/report.js'
import { DISCOVERY_LIMITS } from '../discovery/limits.js'
import { holdsInvisible } from '../schemas/config.js'
import { noteLine, type MergeNote, type Missing } from './protection.js'
import { isBranch, type GitHubRepository } from './remote.js'

/**
 * The text and the address of the one pull request a submission opens (stage
 * 6 brief § 12), written by the engine: the body a person reviews on GitHub,
 * and the URL the CLI prints. Pure; `forge/github/` sends the one and builds
 * the other from what it parsed.
 *
 * The body is the commit's own — `messageFor`'s lines, the files and the
 * label of the request — with each file's path written as code and the
 * request moved inside a fence no line of it can close, so neither a file's
 * name nor a request can mention anyone, link anything, render an image or
 * hide a line in a comment — nor can the base's name, written as code in the
 * note. The engine's block follows: how the change was made (D4), the note
 * on who may merge it when the base's rules call for one (the owner's
 * decision of 2026-10-01), the idp-agent pull requests in flight beside it on
 * other files of the same entities, by number alone (Task 6.3.6), what the
 * branch name means, and that nothing is provisioned until the merge; it ends
 * on `ENGINE_BLOCK_END`. After it, on `init --submit`, goes stage 8's report
 * of what the service's configuration states (`coverageMarkdown`): not the
 * engine's block, because it reports the repository's own words, each of
 * them a code span.
 */

/** The last line of the engine's block: what comes after it is not the engine's. */
export const ENGINE_BLOCK_END = "<!-- idp-agent: end of the engine's block -->"

/** The line `messageFor` writes above the request, kept in the body as it is. */
const REQUESTED = 'Requested, as recorded with the plan (no gate reads it):'

/** Said at the end of every submission, as the CLI says it (`CLOSING`). */
const NOTHING_PROVISIONED = 'Nothing is provisioned yet. The merge is what authorises it.'

export interface PullRequestInput {
  /** The commit's message, as `messageFor` wrote it. */
  readonly message: string
  /** The request as the commit records it (`Cleared.request`). */
  readonly request: string
  /** The road that made the change, which the block names (D4). */
  readonly road: 'from' | 'intent' | 'init' | 'phrase'
  readonly branch: string
  /**
   * The note the rules read just before opening call for, if any: its line is
   * a paragraph of the engine's block. The base reaches the body only through
   * `unguardedNote`, which holds it to the branch grammar and writes it as code.
   */
  readonly note?: { readonly kind: MergeNote; readonly base: string; readonly missing: readonly Missing[] }
  /**
   * The idp-agent pull requests in flight that change other files of the same
   * entities, and the base they are open into: a paragraph of the engine's
   * block naming each by number alone (`besideParagraph`).
   */
  readonly beside?: { readonly numbers: readonly number[]; readonly base: string }
  /**
   * Stage 8's discovery report (`init --submit` alone, carried on its
   * `Cleared`): rendered after `ENGINE_BLOCK_END`, never inside the block.
   */
  readonly coverage?: Coverage
}

/**
 * The paragraph that names the pull requests in flight beside this one —
 * "Opened beside pull request 3 and pull request 12, open into main, which
 * change other files of the same entities.", the base as code. Numbers and
 * the base only — no `#` and no URL: GitHub turns `#<k>` or a pull request's
 * URL in a body into a cross-reference on that pull request's timeline, and
 * may notify its participants, which would be a trace on another person's
 * pull request. The base is code when it holds to the branch grammar and holds
 * no backtick, as the note writes it, else "the base".
 */
export function besideParagraph(numbers: readonly number[], base: string): string {
  const named = numbers.map((number) => `pull request ${String(number)}`)
  const last = named.at(-1) ?? ''
  const listed = named.length < 2 ? last : `${named.slice(0, -1).join(', ')} and ${last}`
  const where = isBranch(base) && !base.includes('`') ? `\`${base}\`` : 'the base'
  return `Opened beside ${listed}, open into ${where}, which change other files of the same entities.`
}

/**
 * The longest paragraph `besideParagraph` writes for a run: twenty pull
 * requests (`GITHUB_LIMITS.inFlightPulls`), each number as long as a double
 * holds exactly, into a base of 255 bytes. Step 8 checks a body's bound with
 * it, before anything is written.
 */
export const LONGEST_BESIDE: string = besideParagraph(
  Array.from({ length: 20 }, () => Number.MAX_SAFE_INTEGER),
  'a'.repeat(255),
)

/** Three backticks, or one more than the longest run in the text: no line of it can close the fence. */
export const fenceFor = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * `text` as a Markdown code span: delimited by one backtick more than its
 * longest run, and padded with a space, which the span drops, when it begins
 * or ends with a backtick or a space. Inside it nothing mentions, links or
 * renders.
 */
export const codeSpan = (text: string): string => {
  const delimiter = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length)) + 1)
  const pad = /^[` ]|[` ]$/.test(text) ? ' ' : ''
  return `${delimiter}${pad}${text}${pad}${delimiter}`
}

/** A file line `messageFor` wrote, `  + <path>` or `  ~ <path>`, its path made code. */
const fileLine = (line: string): string => {
  const file = /^ {2}([+~]) (.+)$/.exec(line)
  return file === null ? line : `  ${file[1] ?? ''} ${codeSpan(file[2] ?? '')}`
}

/**
 * How each road made the change, in D4's words, completing "This change was".
 * `init` is drafted by a model too — the Inspector reads the service's files
 * and the Architect proposes the Component — so it says so: what is a
 * person's there is only what the signature vouches for as typed or answered.
 * Since stage 8's slice 2 (Task 2.3) it runs `plan`'s five gates, the Reviewer
 * last, and what the inspection read is a hint, never a value.
 */
const made = (road: PullRequestInput['road']): string => {
  switch (road) {
    case 'from':
      return 'made from a plan file: four gates, the schema, the signature, the policies and the re-check, and no Reviewer'
    case 'intent':
      return 'drafted by a model: five gates, the schema, the signature, the policies, the re-check and the Reviewer last'
    case 'phrase':
      return 'drafted by a model from a phrase idpa took for a change: five gates, the Reviewer last'
    case 'init':
      return (
        "drafted by a model from the service's own files and written by idpa init in its own repository: " +
        'five gates, the schema, the signature, the policies, the re-check and the Reviewer last, every ' +
        'value the model chose typed or answered by a person'
      )
    default: {
      const _exhaustive: never = road
      return _exhaustive
    }
  }
}

/**
 * The title and the body. The title is the commit's subject, the engine's own
 * words (D18). The body is the message from its third line up to the
 * request's label, each file's path as code, the request fenced, then the
 * engine's block. The line
 * `messageFor` wrote with the request is left out: the same text, outside a
 * fence, would notify, link and render. A message `messageFor` did not write —
 * one without the label — is refused: there is no telling where its request is.
 */
export function pullRequestBody(input: PullRequestInput): { readonly title: string; readonly body: string } {
  const lines = input.message.split('\n')
  const label = lines.indexOf(REQUESTED)
  if (label === -1) throw new Error('a pull request is opened only from a message messageFor wrote')
  const fence = fenceFor(input.request)
  const body = [
    ...lines.slice(2, label + 1).map(fileLine),
    '',
    fence,
    input.request,
    fence,
    '',
    '---',
    '',
    `This change was ${made(input.road)}.`,
    '',
    ...(input.note === undefined ? [] : [noteLine(input.note.kind, input.note.base, input.note.missing, 'markdown'), '']),
    ...(input.beside === undefined || input.beside.numbers.length === 0
      ? []
      : [besideParagraph(input.beside.numbers, input.beside.base), '']),
    `The branch \`${input.branch}\` is named by a digest of its files' paths and bytes: the same change always ` +
      'names the same branch, and any other change another.',
    '',
    NOTHING_PROVISIONED,
    '',
    ENGINE_BLOCK_END,
    ...(input.coverage === undefined ? [] : ['', ...coverageMarkdown(input.coverage)]),
  ]
  return { title: lines[0] ?? '', body: body.join('\n') }
}

/**
 * A path, a value or a rendering as the body writes it: a code span, inside
 * which nothing mentions, links or renders — so a sample's account
 * `@acme-sre` mentions nobody — or undefined for one holding a control, a
 * format or bidi character or a line break, which no code span shows as it is
 * (`holdsInvisible`): counted, never named.
 */
const quoted = (text: string): string | undefined => (holdsInvisible(text) ? undefined : codeSpan(text))

/**
 * Stage 8's report in Markdown (plan, Task 1.4): the heading, § 9's six parts
 * — each label a bold line, each line an item — and the sentence. Built from
 * `coverageSections`, as the terminal's is, with every path, field value and
 * rendering a code span and the words around them the engine's. At most
 * `maxBodyFindings` findings, then their count. No permalink in this version.
 */
export function coverageMarkdown(coverage: Coverage): string[] {
  const sections = coverageSections(coverage, quoted, { findings: DISCOVERY_LIMITS.maxBodyFindings })
  return [
    `**${coverageHeading(coverage, quoted)}.**`,
    '',
    ...sections.flatMap((section) => [
      `**${section.label}**`,
      '',
      ...section.lines.map((line) =>
        line.at === undefined
          ? `- ${line.text}`
          : `- ${line.at} ${line.text}${line.shown === undefined ? '' : ` · ${line.shown}`}`,
      ),
      '',
    ]),
    coverageSentence(coverage),
  ]
}

/**
 * `https://github.com/<owner>/<name>/pull/<number>`, from the owner and name
 * the remote's URL parsed to (held to GitHub's grammar there) and a number
 * GitHub answered, which must be a positive whole number a double holds
 * exactly; never GitHub's `html_url`, which an answer could point anywhere.
 */
export function pullRequestUrl(repository: GitHubRepository, number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('a pull request number is a positive whole number')
  }
  return `https://github.com/${repository.owner}/${repository.name}/pull/${String(number)}`
}
