/**
 * The bounds of stage 8's discovery, in one place so a reader sees every one
 * and a test can name it. Slice 1's first task needs only the parser's; the
 * read adds its own here (plan, Task 1.2).
 */
export const DISCOVERY_LIMITS = {
  /**
   * A connection string longer than this is `unparsed` before a character of
   * it is read: no driver's documentation writes one this long, and a bound
   * known before the scan is what keeps every scan below linear in a known n.
   */
  maxConnectionLength: 4_096,
  /** The hosts one connection string may name: a replica set, a libpq list. More is refused, never cut. */
  maxHosts: 8,
  /** An http URL a finding keeps: the origin alone, and no longer than this. */
  maxUrlLength: 2_048,
} as const
