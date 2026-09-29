import type { Base } from '../../forge/provider.js'
import { inertLine } from './plain.js'

/** The one line every run that produced a diff ends on (design §7.4). */
export const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

/**
 * Said wherever a local branch was cut, so nobody looks for a pushed branch or
 * a merge request that does not exist.
 */
const NO_FORGE = 'Nothing is pushed. No merge request is opened: this build has no forge (stage 6).'

/**
 * What became of a diff. `preview` is stage 4's sentence, unchanged; the rest
 * exist only with `--submit`, and none of them says "applied" — a submission
 * is a request (§4.2).
 *
 * Imports a forge's shapes as types only: the rule "only cli/ reaches forge/ at
 * runtime" would allow more here, and nothing here needs it.
 */
export type PreviewStatus =
  | { readonly kind: 'preview' }
  | { readonly kind: 'pending'; readonly branch: string }
  | { readonly kind: 'declined' }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] }
  | { readonly kind: 'submitted'; readonly again: boolean; readonly branch: string; readonly base: Base }
  /** `init`'s preview ends on its `apply` sentence instead of `CLOSING`: the tail it says in place of it. */
  | { readonly kind: 'applied-by-hand'; readonly apply: string }

const short = (commit: string): string => commit.slice(0, 7)

/**
 * The base as a person reads it: `main@abc1234`. Its branch is the
 * repository's own — after a clone, whatever the remote named its default —
 * and git takes a bidi control in a ref name, so it is printed through
 * `inertLine`: this is the line that says which base a request sits on. The
 * `--json` report carries the name as it is.
 */
export const baseOf = (base: Base): { readonly at: string; readonly branch: string } => {
  const branch = inertLine(base.branch, Number.POSITIVE_INFINITY)
  return { at: `${branch}@${short(base.commit)}`, branch }
}

/**
 * The last lines of a run that produced a diff: the count, what was done with
 * it, and §7.4's sentence. A diff printed by a confirmation prompt is not
 * printed again, and these lines are then the whole of the result.
 */
export function closingLines(status: PreviewStatus, changed: number): string[] {
  const files = `${String(changed)} ${changed === 1 ? 'file' : 'files'}`
  switch (status.kind) {
    case 'preview':
      return [`${files} · nothing written`, CLOSING]
    case 'applied-by-hand':
      return [`${files} · nothing written`, status.apply]
    case 'pending':
      return [`${files} · not yet submitted — it would become ${status.branch}`, CLOSING]
    case 'declined':
      return [`${files} · not submitted · nothing written`, CLOSING]
    case 'refused':
      return [
        `${files} · not submitted:`,
        ...status.reasons.map((reason) => `  ${reason}`),
        'Nothing was written.',
        CLOSING,
      ]
    case 'submitted': {
      const base = baseOf(status.base)
      return [
        status.again
          ? `${files} · already submitted as ${status.branch} · nothing written`
          : `${files} · submitted as ${status.branch} on top of ${base.at} · ${base.branch} untouched`,
        NO_FORGE,
        CLOSING,
      ]
    }
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}
