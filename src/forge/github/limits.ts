/**
 * What one submission to GitHub may spend (stage 6 brief § 15, amended by Task
 * 6.3.6 of the stage 6 plan), one constant each. The per-call bounds — 15 s
 * and 1 MiB per gh answer — are the gh launcher's own (`process/gh.ts`'s
 * `GH_LIMITS`); these are the run's.
 *
 *   - `submissionMs`: a whole submission, the push's 120 s included.
 *   - `ghCalls`: the version and the identity 2; the preflight 13 (the
 *     repository, the rules, at most ten rulesets, the base ref); the
 *     re-check 12; recognition 3; the read-back at most 3; the rules before
 *     the pull request 11; the pull request 1; re-reads after a lease refusal
 *     or a 422 at most 3 — 48 — then what is in flight: the first read, at
 *     most 3 pages and 20 file lists, 23; step 8's, page 1 and at most 20 file
 *     lists, 21 — 92, exactly. A 93rd is a programming error.
 *   - `rulesets`: read per check; `pullsPage`: one page of pull requests.
 *   - `inFlightPages`: the pages of open pull requests into the base the first
 *     read asks for, one by one; past them, what is in flight cannot be read
 *     whole. `inFlightPulls`: the idp-agent pull requests a run compares with,
 *     each one file list; more is refused rather than judged on a part.
 *   - `readBack`: the waits, in milliseconds, before the second and the third
 *     read of a pushed ref.
 *   - `bodyBytes`: a pull request's body.
 */
export const GITHUB_LIMITS = {
  submissionMs: 180_000,
  ghCalls: 92,
  rulesets: 10,
  pullsPage: 100,
  inFlightPages: 3,
  inFlightPulls: 20,
  readBack: [500, 1500],
  bodyBytes: 1024 * 1024,
} as const
