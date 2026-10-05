/**
 * The shapes a credential is known by, and the shapes a value that names
 * another value is: moved here from `context/project-fs/secrets.ts`, unchanged
 * in behaviour, so that two readers judge one text with one copy of them.
 * `project-fs`'s secret filter reads them to withhold a file from a model;
 * `core/discovery/` reads them to refuse a field a credential could sit in,
 * and to tell a reference (`${DB_HOST}`) from a value (stage 8, slice 1).
 *
 * Pure: constants and functions of a string. Every pattern below is a fact
 * about a token's issuer or a placeholder's syntax, never a guess about
 * entropy, and `secrets.ts` says what that misses.
 */

export interface CredentialShape {
  /** What it is, for a reader and a test. Never part of a reason. */
  readonly name: string
  /**
   * Global, so every occurrence in a file is examined. A named group `value`,
   * when there is one, is the part a placeholder is judged on; otherwise the
   * whole match is.
   */
  readonly pattern: RegExp
  /** The prefix, and what the length or the charset is there to rule out. */
  readonly why: string
}

/**
 * Credentials by the shape their issuer stamps on them — prefixes first,
 * because a prefix is a fact about the token and not a guess about the file.
 * These turn up in `database.yml`, a Dockerfile, a shell script or a note,
 * where no name rule reaches.
 *
 * Every body has a minimum length, so a truncated one in documentation
 * (`sk-ant-api03-...`) is not a token; and every match is then held to
 * `placeholderToken`, so AWS's own `…EXAMPLE` key and `ghp_xxxx…` are not
 * either.
 */
export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
  {
    name: 'Anthropic API key',
    pattern: /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{32,}/g,
    why: '`sk-ant-`, a kind and a version (`api03`, `admin01`), then about ninety URL-safe characters',
  },
  {
    name: 'OpenAI scoped key',
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g,
    why: '`sk-proj-`, `sk-svcacct-` or `sk-admin-`, then a long URL-safe body; the unscoped rule below stops at their hyphen',
  },
  {
    name: 'OpenAI key, unscoped',
    pattern: /\bsk-[A-Za-z0-9]{20,}/g,
    why: '`sk-` and twenty alphanumerics at least; the word boundary keeps `task-` and `risk-` out',
  },
  {
    name: 'GitHub fine-grained token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}/g,
    why: '`github_pat_`, then 82 characters in two parts joined by `_`',
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    why: '`ghp_` (personal), `gho_` (OAuth), `ghu_` / `ghs_` (app user / server), `ghr_` (refresh), then 36 alphanumerics',
  },
  {
    name: 'GitLab personal access token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    why: '`glpat-`, then twenty URL-safe characters',
  },
  {
    name: 'Slack token',
    pattern: /\bxox[abposr]-\d+-[A-Za-z0-9-]{10,}/g,
    why: '`xoxb-` (bot), `xoxp-` (user), `xoxa-` / `xoxr-` (app, refresh), then a numeric id: `xoxb-your-token` has none',
  },
  {
    name: 'Slack webhook',
    pattern: /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,}/g,
    why: 'the webhook URL is the credential: whoever holds it posts to the channel',
  },
  {
    name: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    why: '`AKIA` (long-lived) or `ASIA` (temporary), then exactly sixteen upper-case alphanumerics',
  },
  {
    name: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    why: '`AIza`, then exactly 35 URL-safe characters',
  },
  {
    name: 'Stripe live key',
    pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/g,
    why: '`sk_live_` (secret) or `rk_live_` (restricted); a test-mode key moves no money and is not listed',
  },
  {
    name: 'npm token',
    pattern: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    why: '`npm_`, then exactly 36 alphanumerics; `npm_config_cache` is a variable, and too short',
  },
  {
    name: 'Hugging Face token',
    pattern: /\bhf_[A-Za-z]{34}(?![A-Za-z])/g,
    why: '`hf_`, then exactly 34 letters; `hf_hub_download` is a function',
  },
  {
    name: 'SendGrid API key',
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    why: '`SG.`, then two URL-safe parts of fixed length',
  },
  {
    name: 'Azure storage account key',
    pattern: /\bAccountKey=(?<value>[A-Za-z0-9+/]{80,}={0,2})/g,
    why: 'the `AccountKey=` of a connection string, 88 base64 characters; `AccountKey=${KEY}` is a reference',
  },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g,
    why: 'two base64url JSON objects, header and claims; a signed one is a bearer credential until it expires',
  },
  {
    name: 'URL with a password in its userinfo',
    pattern:
      /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/'"<>]{0,128}:(?!\d{1,5}(?:\/|$))(?<value>[^\s@'"<>]{1,256})@[^\s/'"<>@]/gi,
    why: '`scheme://user:password@host`, the user possibly empty (`redis://:password@host`); judged on the password, so `${DB_PASSWORD}` and the textbook `user:password` are read, and a port followed by a path (`host:8080/@x`) is not a password',
  },
]

/**
 * A token-shaped match that is somebody's example rather than a token: AWS
 * documents `AKIAIOSFODNN7EXAMPLE`, and a README writes `ghp_xxxx…`. A run of
 * six identical characters, or the word, appears in no issued token worth the
 * name — a random body of 36 has about a one in twenty million chance of
 * either.
 */
export const placeholderToken = (token: string): boolean =>
  /example/i.test(token) || /(.)\1{5,}/.test(token)

/**
 * A value that names another value rather than being one — each in its WHOLE
 * shape, never by its first character. `password: ${DB_PASSWORD}`,
 * `${{ secrets.TOKEN }}`, `<your-key-here>`, `%TOKEN%`, `{{ .Values.password }}`,
 * `@db.password@` and `$(cat /run/secrets/db)` are the normal content of a
 * configuration file, and refusing them would refuse half of every project.
 *
 * `$NAME` is a reference only in one case, as an environment variable is
 * written: `$DB_PASSWORD`, `$db_password`. `$Qx7mPz2` is a password that
 * starts with a dollar sign; the rule this replaced took every leading `$`,
 * `%`, `(`, `!`, `@` and `*` for syntax, and read the password (review).
 */
const REFERENCES: readonly RegExp[] = [
  /^\$\{/,
  /^\$\(/,
  /^\$[A-Z_][A-Z0-9_]*$/,
  /^\$[a-z_][a-z0-9_]*$/,
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,
  /^%\(/,
  /^<[^>]+>$/,
  /^<%/,
  /^\{\{/,
  /^\{%/,
  /^#\{/,
  /^@[\w.-]+@$/,
  /^\([^)]*\)$/,
]

const PLACEHOLDER_WORDS =
  /^(?:null|none|nil|undefined|true|false|yes|no|on|off|changeme|change[-_]me|todo|tbd|redacted|placeholder|include|omit|same-origin|inherit|required|optional|enabled|disabled|example|xxx+|\*+)$/i
/** Words a placeholder holds anywhere, because no generated value holds them. */
const PLACEHOLDER_INSIDE = /placeholder|changeme|change[-_]me|(.)\1{5,}/i
/** `example` and `xxxx` only as a word of their own: `Example9Qx…` is a password. */
const PLACEHOLDER_WORD_INSIDE = /(?:^|[^A-Za-z0-9])(?:example|x{4,})(?:[^A-Za-z0-9]|$)/i
/**
 * An ellipsis only as the whole value, or after a short prefix — the way
 * documentation truncates a token (`ghp_...`). Latin-1 is how `snapshot.ts`
 * decodes, so `…` arrives as its three UTF-8 bytes.
 */
const ELLIPSIS = /^(?:[\w-]{0,12})(?:\.{3,}|…|â\u0080¦)$/
const PLACEHOLDER_LEAD = /^(?:your|insert|replace|enter)[-_.]/i
const VERSION_CONSTRAINT =
  /^(?:[\^~]|[<>]=?|=)\s*v?\d|^(?:workspace|npm|file|link|portal|patch|catalog|github|git\+[a-z]+):|^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i
const ENVIRONMENT_READ =
  /^(?:process\.env\b|import\.meta\.env\b|os\.environ\b|os\.getenv\(|getenv\(|env\(|ENV\[|ENV\.fetch\(|System\.getenv\(|Environment\.GetEnvironmentVariable\()/

/**
 * Whether a value is written as a reference to another value, by the shapes
 * above alone: what discovery's connection parser holds a host, a database or
 * a user to, where a run of six characters or a version would be a value
 * outside its grammar rather than one configured elsewhere.
 */
export const referenceShape = (value: string): boolean => REFERENCES.some((reference) => reference.test(value))

/** What every value, quoted or not, is held to. */
export const placeholderShape = (value: string): boolean =>
  REFERENCES.some((reference) => reference.test(value)) ||
  PLACEHOLDER_WORDS.test(value) ||
  PLACEHOLDER_INSIDE.test(value) ||
  PLACEHOLDER_WORD_INSIDE.test(value) ||
  ELLIPSIS.test(value) ||
  PLACEHOLDER_LEAD.test(value) ||
  VERSION_CONSTRAINT.test(value) ||
  ENVIRONMENT_READ.test(value)

/**
 * The password of a URL: only a whole reference (`${…}`, `$NAME`, `<…>`,
 * `{{…}}`, `%NAME%`), a placeholder word, or one of the five words a README
 * uses in its place — `postgres://user:password@localhost` is the example
 * every driver's documentation prints. A leading `%` is percent-encoding
 * (`%40` is `@`), and a leading `$` or `!` is a character, so neither makes a
 * password a reference here.
 */
const URL_REFERENCES: readonly RegExp[] = [
  /^\$\{[^}]*\}$/,
  /^\$[A-Z_][A-Z0-9_]*$/,
  /^\$[a-z_][a-z0-9_]*$/,
  /^<[^>]*>$/,
  /^\{\{.*\}\}$/,
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,
]
export const placeholderPassword = (value: string): boolean =>
  URL_REFERENCES.some((reference) => reference.test(value)) ||
  PLACEHOLDER_WORDS.test(value) ||
  PLACEHOLDER_INSIDE.test(value) ||
  PLACEHOLDER_WORD_INSIDE.test(value) ||
  ELLIPSIS.test(value) ||
  PLACEHOLDER_LEAD.test(value) ||
  /^(?:pass|passwd|password|pwd|secret)$/i.test(value)
