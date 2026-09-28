/**
 * Every bound of a catalogue read (docs/backstage-http-brief.md § 6), in one
 * place. Each is stated in the line that reports reaching it, and a bound that
 * would leave the graph incomplete ends the run: a partial read is refused,
 * never answered from, because a reference left unloaded would read as
 * declared nowhere.
 *
 * The transport (`transport.ts`) keeps the bounds of one request and of the
 * bytes and retries of a run; the load (1.4) keeps the counts, the load's own
 * time and the shape of what it reads.
 */
export const BACKSTAGE_LIMITS = {
  /** Sent as `limit` on every page, never left to the server: the docs say 20, the code 200. */
  pageSize: 250,
  /** Components, Resources and APIs read whole; past it the read is refused, not answered from. */
  modelledEntities: 20_000,
  /**
   * Groups, Users, Systems and Domains, read for the fields the read model
   * reads of them; past it, refused the same way. Its own, since Users are
   * most of a company catalogue: at those fields a User is about 260 bytes of
   * JSON, so 200,000 of them are about 50 MiB, under `bytesPerRun`.
   */
  organisationEntities: 200_000,
  /** References of every other kind, read as refs only; past it, refused the same way. */
  otherRefs: 200_000,
  /** One response's body, counted while it streams, before any of it is parsed. */
  bytesPerResponse: 32 * 1024 * 1024,
  /** Every body of a run together. */
  bytesPerRun: 256 * 1024 * 1024,
  /** One request, its body read included. */
  requestMs: 15_000,
  /** The whole load, every request and every wait of a 429 included. */
  loadMs: 120_000,
  /** The longest `Retry-After` a 429 is waited for; a longer one is refused at once. */
  retryAfterMs: 10_000,
  /** How many 429s a run waits for, across all its requests. */
  retriesPerRun: 3,
  /** The deepest an entity may nest; a deeper one is set aside, with the reason. */
  jsonDepth: 64,
} as const

/**
 * The bounds as numbers. `typeof BACKSTAGE_LIMITS` is literal types — `250`,
 * not `number` — and a test that lowers a bound to reach it needs another value.
 */
export type BackstageLimits = { readonly [K in keyof typeof BACKSTAGE_LIMITS]: number }
