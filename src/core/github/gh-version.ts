/**
 * The oldest gh this build reads (stage 6 brief § 9, § 17): the oldest gh a
 * committed run of the owner's live test was made with — 2.96.0, on
 * 2026-10-02 (`tests/contract/github/`). The fake gh answers it
 * (`tests/support/fake-gh.ts`'s `FAKE_GH_VERSION`), and
 * `tests/contract/github-answers.test.ts` holds the three to one value. A
 * later run with an older gh, committed, lowers it; nothing raises it but a
 * newer oldest run.
 */
export const GH_MINIMUM_VERSION = '2.96.0'

/**
 * The version `gh --version` prints on its first line, `gh version 2.96.0
 * (2026-07-02)`: three numbers, a pre-release suffix dropped (`2.62.0-rc.1`
 * is read as `2.62.0`). Undefined for anything else — a build from source
 * says `gh version DEV` — and for a number of more than nine digits.
 */
export function parseGhVersion(stdout: string): string | undefined {
  const first = stdout.split('\n', 1)[0] ?? ''
  return /^gh version ([0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9})(?:-[0-9A-Za-z.-]+)?(?: |$)/.exec(first)?.[1]
}

/** `version` is `minimum` or later, compared as numbers part by part: 2.9.0 is older than 2.10.0. */
export function isAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const left = a[at] ?? 0
    const right = b[at] ?? 0
    if (left !== right) return left > right
  }
  return true
}
