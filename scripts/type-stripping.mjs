/**
 * Whether this Node runs TypeScript as it is: `tools/fake-backstage.ts`, which
 * `pnpm demo:backstage` starts, needs it. On by default from Node 22.18;
 * behind a flag from 22.10, where `process.features.typescript` is `false`
 * without it; and before 22.10 the property does not exist. `engines` allows
 * all of them, so the demo refuses and the smoke skips it, each saying why.
 *
 * Shared by `scripts/demo-backstage.mjs` and `scripts/smoke.mjs`, and read
 * with the features handed in by `tests/unit/package-scripts.test.ts`.
 *
 * @param {{ typescript?: unknown }} [features]
 * @param {string} [version]
 * @returns {string | undefined} why it cannot run here, or nothing when it can
 */
export function strippingRefusal(features = process.features, version = process.version) {
  return features.typescript ? undefined : `it needs Node 22.18 or later (this is ${version})`
}
