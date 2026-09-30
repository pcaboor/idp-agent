import fc from 'fast-check'

/**
 * How long a property may run, and what it says when it runs longer.
 *
 * Vitest's own limit is five seconds a test, and a property is not a test's
 * usual size: §9.2's idempotence takes about one second alone and one and a
 * half in a full run, and on 2026-09-29 it failed once in a full run started
 * beside others, its error text lost. Reproduced by starving it of CPU (24
 * busy loops on 8 cores, the test at the lowest priority): "Test timed out in
 * 5000ms" — and a timeout carries no seed, so the failure could be neither
 * replayed nor told apart from a counterexample. 60 000 runs of the property
 * over three seeds found none.
 *
 * So the limit is raised well past what contention stretches a run to, and
 * fast-check is stopped first, a little inside it, and reports the stop as a
 * failure: if a run ever does take that long, the report is fast-check's, and
 * it names the seed and the path to replay it (`fc.assert(…, { seed, path })`).
 * A counterexample is reported the same way, as it always was.
 *
 * Imported for this effect by every file of properties here. Vitest runs each
 * test file in a context of its own, so the setting reaches no other file.
 */
export const PROPERTY_TIMEOUT = 60_000

fc.configureGlobal({
  ...fc.readConfigureGlobal(),
  interruptAfterTimeLimit: 50_000,
  markInterruptAsFailure: true,
})

/**
 * A seed drawn here rather than by fast-check, for a property followed by a
 * floor: fast-check names its seed for a counterexample or a stop, and a floor
 * that trips after `fc.assert` returned is neither. Handed to `fc.assert` and
 * named in each floor's message, it replays the run that fell short. Drawn the
 * way fast-check draws its own, so each run still explores new input.
 */
export const freshSeed = (): number => Date.now() ^ (Math.random() * 0x100000000)
