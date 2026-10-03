import { defineConfig } from 'vitest/config'

// The owner's live test of stage 6 (docs/plans/stage-6-github.md, Task 6.4.1),
// run by hand with `pnpm test:live:github` and never in CI: it reaches GitHub
// with the owner's own gh and git, against their throwaway repository. Nothing
// of the default suite is loaded — not its floor, which would refuse the very
// network this test needs, and not its run directory: the live test makes and
// removes its one temporary directory itself. tests/live/setup.ts refuses to
// start without IDP_GITHUB_LIVE_REPO.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    setupFiles: ['tests/live/setup.ts'],
    // One file at a time: two runs against one repository would race.
    fileParallelism: false,
    // The steps run in the order written, one after the other, each once: the
    // approval comes only in step 5, after every door, and a step retried
    // would try a door or an approval again. Pinned here, so no flag on the
    // command line is needed to keep it, and tests/unit/live-config.test.ts
    // holds the pins.
    sequence: { shuffle: false, concurrent: false },
    retry: 0,
    // § 15's bound on one submission, for every step and every hook.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
