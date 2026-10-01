import type { GitHubRepository } from './remote.js'

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
 * hide a line in a comment. The engine's block follows: how the
 * change was made (D4), what the branch name means, and that nothing is
 * provisioned until the merge; it ends on `ENGINE_BLOCK_END`, after which
 * stage 8's report will go.
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
}

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
const codeSpan = (text: string): string => {
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
 * person's there is only what the signature vouches for as typed.
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
        'two gates, the schema and the signature, every value the model chose either read by the inspection ' +
        'or typed by a person, and no Reviewer'
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
    `The branch \`${input.branch}\` is named by a digest of its files' paths and bytes: the same change always ` +
      'names the same branch, and any other change another.',
    '',
    NOTHING_PROVISIONED,
    '',
    ENGINE_BLOCK_END,
  ]
  return { title: lines[0] ?? '', body: body.join('\n') }
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
