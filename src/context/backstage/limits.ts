/**
 * Every bound of a catalogue read (docs/backstage-http-brief.md § 6), in one
 * place. Each is stated in the line that reports reaching it. The three count
 * ceilings are bounds a read stops at: what it read is answered from, every
 * answer says the graph is partial, and a reference into what was left out is
 * not loaded, never declared nowhere (ADR-0013). Every other bound ends the
 * run: a read cut there is cut wherever a broken or hostile server chose.
 *
 * The transport (`transport.ts`) keeps the bounds of one request and of the
 * bytes and retries of a run; the load (1.4) keeps the counts, the load's own
 * time and the shape of what it reads.
 */
export const BACKSTAGE_LIMITS = {
  /** Sent as `limit` on every page, never left to the server: the docs say 20, the code 200. */
  pageSize: 250,
  /** Components, Resources and APIs read whole; the read stops there, and what is past it is not loaded. */
  modelledEntities: 20_000,
  /**
   * Groups, Users, Systems and Domains, read for the fields the read model
   * reads of them; the read stops there, and is then not judged. Its own, since Users are
   * most of a company catalogue: at those fields a User is about 260 bytes of
   * JSON, so 200,000 of them are about 50 MiB, under `bytesPerRun`.
   */
  organisationEntities: 200_000,
  /** References of every other kind, read as refs only; the read stops there, and what is past it is not loaded. */
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

/**
 * The bounds of a catalogue read kept on disk (`cache.ts`): how long a copy
 * answers without asking the catalogue, how long a copy nobody writes again
 * is kept, and the longest header a copy may have. Not a bound of the read,
 * so no part of a copy's key.
 */
export const CATALOGUE_CACHE = {
  /** A copy younger than this is read instead of the catalogue: of the order of the catalogue's own lag. */
  ttlMs: 5 * 60_000,
  /** A copy older than this is removed by the next run that writes one (the owner's answer to question 1). */
  keepMs: 7 * 24 * 60 * 60_000,
  /** The longest header line a copy may have. */
  headerBytes: 4096,
} as const
