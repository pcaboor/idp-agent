/**
 * The suite must be unable to reach the network — not by convention, not by
 * everyone remembering. A forgotten recording has to fail loudly rather than
 * quietly calling a provider on whoever's key happens to be in the shell.
 *
 * Recording is the one legitimate reason to want the network, and it is opt-in
 * through the documented variable (design 9.3).
 */
const recording = process.env['IDP_RECORDING'] === 'record'

if (!recording) {
  const blocked = (input: unknown): never => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    throw new Error(
      `the test suite reached the network (${target}). ` +
        'Replay a recording, or record one with IDP_RECORDING=record pnpm test.',
    )
  }

  globalThis.fetch = blocked as unknown as typeof globalThis.fetch
}
