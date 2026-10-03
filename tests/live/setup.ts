import { prepareLiveRun } from './guard.js'

// The live run's only setup file (vitest.live.config.ts): the environment
// scrubbed, then the throwaway repository required, so a run without
// IDP_GITHUB_LIVE_REPO stops here, naming it, before any test file is
// imported and before any gh or git starts. tests/unit/live-config.test.ts
// runs this file under a scratch configuration to prove both.
prepareLiveRun(process.env)
