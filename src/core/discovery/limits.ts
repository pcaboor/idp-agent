/**
 * The bounds of stage 8's discovery, in one place so a reader sees every one
 * and a test can name it: the parser's (plan, Task 1.1), the read's (Task
 * 1.2), then the re-read's (Task 1.3). The findings' caps arrive with the
 * extractors that count them.
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
  /**
   * A file the read opens, as the snapshot's cap. Over it the file is named
   * and never cut: half a manifest is a lie an extractor would read whole.
   */
  maxFileBytes: 65_536,
  /**
   * The folders one walk descends into, as the snapshot's own floor: past it
   * the walk stops and says so (`truncated`), rather than hold the process.
   */
  maxDirectories: 5_000,
  /** The YAML documents of one file. More is a file that cannot be read whole, never one read in part. */
  maxYamlDocuments: 100,
  /**
   * A finding's span, in lines and in bytes, as the re-read holds it (Task
   * 1.3): a span is where a finding was read, never a quote of the file, so
   * one past either bound is refused rather than cut.
   */
  maxSpanLines: 20,
  maxSpanBytes: 1_024,
} as const

/** The bounds as numbers, so a test can shrink one (`readDiscovery`'s `limits`). */
export type DiscoveryLimits = { readonly [Bound in keyof typeof DISCOVERY_LIMITS]: number }
