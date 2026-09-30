import { GitError, type Push, type PushRequest } from '../../process/git.js'

/**
 * Step 10 of stage 6 brief § 3: the person's own `git push` of the very
 * commit the local forge cut, create-only (`pushIn`, § 4), and what its
 * answer means. git's words are read to classify a failure and never
 * repeated: each class has one engine sentence (§ 15).
 *
 * A push that did not answer "created" is read back before anything is
 * concluded, since the push may have landed and its answer been lost — a
 * lease refusing a ref that is ours already, a network that dropped after
 * the server wrote — and read back as step 11 reads, with its waits, since
 * GitHub's API can lag behind a push. Our commit there is the push having
 * landed; another commit is somebody else's branch, never moved; nothing
 * there after the last wait is the push refused, said in its class's words.
 */

/** What a failed push was, read from git's exit and stderr. */
export type PushFailure = 'authentication' | 'host-key' | 'lease' | 'ruleset' | 'network' | 'other'

/**
 * The classes, in the order they are tried. Authentication before the
 * network: `Could not read from remote repository` follows a refused key too,
 * and is not read at all.
 */
const SIGNS: readonly (readonly [Exclude<PushFailure, 'other'>, RegExp])[] = [
  ['authentication', /permission denied \(publickey|authentication failed|could not read username|terminal prompts disabled/i],
  ['host-key', /host key verification failed|remote host identification has changed/i],
  ['lease', /stale info/i],
  ['ruleset', /GH013|repository rule violations/i],
  ['network', /could not resolve host|connection refused|connection timed out|connection reset/i],
]

export function classifyPushFailure(error: GitError): PushFailure {
  if (error.timedOut) return 'network'
  return SIGNS.find(([, sign]) => sign.test(error.stderr))?.[0] ?? 'other'
}

/**
 * A `!` porcelain line, read from its summary: the lease finding the ref, or
 * GitHub's words for a ruleset — `GH013`, `repository rule violations` — and
 * anything else, a hook or a limit of the remote's, `other`. A remote's
 * refusal is never taken for a ruleset it does not name.
 */
const classifyRejection = (summary: string): PushFailure =>
  SIGNS.find(([failure, sign]) => (failure === 'lease' || failure === 'ruleset') && sign.test(summary))?.[0] ?? 'other'

/** One engine sentence per class, git's words never quoted; `where` is `github.com/<o>/<r>`. */
const failed = (failure: PushFailure, where: string): string => {
  switch (failure) {
    case 'authentication':
      return 'your git could not authenticate to github.com; `git push` in this clone would fail the same way'
    case 'host-key':
      return "your ssh does not trust github.com's host key; `ssh -T git@github.com` says why"
    case 'ruleset':
      return `a ruleset on ${where} forbids creating idp-agent/… branches`
    case 'network':
      return 'the push to github.com did not complete: the network failed or took longer than 120 s'
    // A lease found the ref, which is gone when read back: nothing this build
    // can name.
    case 'lease':
    case 'other':
      return 'the push to github.com failed; `git push` in this clone would say why'
    default: {
      const _exhaustive: never = failure
      return _exhaustive
    }
  }
}

/**
 * What the push left: `landed`, this run's push created the ref, or git
 * found it up to date, and the forge reads it back (step 11); `ours`, read
 * back already and found at our commit; `refused`, with the sentence.
 */
export type Pushed =
  | { readonly kind: 'landed'; readonly pushed: boolean }
  | { readonly kind: 'ours' }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Pushes `request`, and says what it left. `readBack` is step 11's read of the
 * branch on GitHub, with its waits: `ours` at `request.commit`, `other` at
 * another commit, `absent` after the last wait; `notOurs` is the sentence for
 * a branch that carries a different change.
 */
export async function pushChange(input: {
  readonly push: Push
  readonly request: PushRequest
  readonly where: string
  readonly readBack: () => Promise<'ours' | 'other' | 'absent'>
  readonly notOurs: string
}): Promise<Pushed> {
  const { request } = input
  let failure: PushFailure | undefined
  try {
    const outcome = await input.push(request)
    switch (outcome.flag) {
      case 'created':
        return { kind: 'landed', pushed: true }
      case 'up-to-date':
        return { kind: 'landed', pushed: false }
      case 'rejected':
        // `[rejected] (stale info)`: the lease found the ref. Anything else is
        // the remote refusing it, a ruleset only where GitHub says so.
        failure = classifyRejection(outcome.summary)
        break
      default: {
        const _exhaustive: never = outcome.flag
        return _exhaustive
      }
    }
  } catch (error) {
    // Anything but git's own failure is a push whose answer never came: read
    // back like the rest, and said in the words of the class nothing names.
    failure = error instanceof GitError ? classifyPushFailure(error) : 'other'
  }

  const found = await input.readBack()
  switch (found) {
    case 'ours':
      return { kind: 'ours' }
    case 'other':
      return { kind: 'refused', reason: input.notOurs }
    case 'absent': {
      const nothing = `${request.branch} was cut in this clone and nothing is on GitHub`
      return { kind: 'refused', reason: `${failed(failure ?? 'other', input.where)}. ${nothing}` }
    }
    default: {
      const _exhaustive: never = found
      return _exhaustive
    }
  }
}
