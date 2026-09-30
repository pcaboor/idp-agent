/**
 * The oldest gh this build reads (stage 6 brief § 9, § 17). Provisional: the
 * version the fake gh answers (`tests/support/fake-gh.ts`'s `FAKE_GH_VERSION`),
 * until the owner's live run records the version it was made with and pins it
 * here (stage 6 plan, Task 6.4.1).
 */
export const GH_MINIMUM_VERSION = '2.40.0'

/**
 * The version `gh --version` prints on its first line, `gh version 2.40.0
 * (2023-12-07)`: three numbers, a pre-release suffix dropped (`2.62.0-rc.1`
 * is read as `2.62.0`). Undefined for anything else — a build from source
 * says `gh version DEV` — and for a number of more than nine digits.
 */
export function parseGhVersion(stdout: string): string | undefined {
  const first = stdout.split('\n', 1)[0] ?? ''
  return /^gh version ([0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9})(?:-[0-9A-Za-z.-]+)?(?: |$)/.exec(first)?.[1]
}

/** `version` is `minimum` or later, compared as numbers part by part: 2.9.0 is older than 2.40.0. */
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
