/**
 * The bounds of stage 8's discovery, in one place so a reader sees every one
 * and a test can name it: the parser's (plan, Task 1.1), the read's (Task
 * 1.2), the re-read's (Task 1.3), then the extractors' and the report's (Task
 * 1.4).
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
  /**
   * The findings of one file (Task 1.4). Past it the file is refused whole,
   * `over-finding-cap`, and no finding of it is kept: a file read in part is
   * a file whose rest nobody reported.
   */
  maxFindingsPerFile: 200,
  /** The findings of one run. Every file past it is named, `past-run-cap`, and none of its findings kept. */
  maxFindingsPerRun: 1_000,
  /**
   * How deep a `package.json` may nest, measured on its bytes before any
   * parser runs: a 64 KiB `[[[[…` is a parse failure, never a stack overflow.
   */
  maxJsonDepth: 64,
  /** The paths the report names in one group, then how many more. */
  maxListed: 20,
  /** The findings a pull request's body lists, then their count; the terminal lists every one up to the run's cap. */
  maxBodyFindings: 100,
} as const

/** The bounds as numbers, so a test can shrink one (`readDiscovery`'s `limits`). */
export type DiscoveryLimits = { readonly [Bound in keyof typeof DISCOVERY_LIMITS]: number }
