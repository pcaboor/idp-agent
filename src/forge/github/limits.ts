/**
 * What one submission to GitHub may spend (stage 6 brief § 15), one constant
 * each. The per-call bounds — 15 s and 1 MiB per gh answer — are the gh
 * launcher's own (`process/gh.ts`'s `GH_LIMITS`); these are the run's.
 *
 *   - `submissionMs`: a whole submission, the push's 120 s included.
 *   - `ghCalls`: the version and the identity 2; the preflight 13 (the
 *     repository, the rules, at most ten rulesets, the base ref); the
 *     re-check 12; recognition 3; the read-back at most 3; the rules before
 *     the pull request 11; the pull request 1; re-reads after a lease refusal
 *     or a 422 at most 3 — 48, exactly. A 49th is a programming error.
 *   - `rulesets`: read per check; `pullsPage`: one page of pull requests.
 *   - `readBack`: the waits, in milliseconds, before the second and the third
 *     read of a pushed ref.
 *   - `bodyBytes`: a pull request's body.
 */
export const GITHUB_LIMITS = {
  submissionMs: 180_000,
  ghCalls: 48,
  rulesets: 10,
  pullsPage: 100,
  readBack: [500, 1500],
  bodyBytes: 1024 * 1024,
} as const
