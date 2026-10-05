/**
 * What a secret looks like in the TEXT of a file: the content half of
 * `project-fs`'s filter, the half no file name can dodge. `snapshot.ts` asks
 * `secretIn` about every file it is about to hand over, and withholds the file
 * when the answer is anything but `undefined`.
 *
 * Pure, and on purpose: no disk, no clock, nothing but a string in and a class
 * out, so the rules below are tested as a table rather than through a
 * filesystem, and a reader can see all of them in one place.
 *
 * Three rules hold throughout, and each was a defect before it was a rule:
 *
 *   - EVERY match is examined, never only the first. A single placeholder —
 *     `${DB_PASSWORD}`, `changeme` — ahead of a literal used to let the whole
 *     file through (review, security-1). A file is withheld when ANY match is
 *     a literal; a file of placeholders alone is read.
 *   - A file is WITHHELD, never redacted. A redaction is only as good as the
 *     span a pattern happened to find — a value that runs past it, a second
 *     line of a block scalar, an escape inside a JSON string — and the model is
 *     handed a file with a hole in it and reads it as whole. A withheld file is
 *     named in `skipped`, and the Inspector reports what it held as unknown:
 *     recoverable. A key sent to a provider is not.
 *   - A doubt about a VALUE withholds; only a doubt about a NAME reads. A key
 *     is judged generously — `DBPASSWORD`, `jwtsecret`, `--db-password`,
 *     `-Dspring.datasource.password` all name a secret — and a value is a
 *     placeholder only in a shape that cannot be anything else: `${…}`, a
 *     whole `<…>`, `changeme`. A leading `!`, `@`, `$` or `%` is a character a
 *     generated password starts with as often as any other.
 *
 * The text is examined as written, then with its `\uXXXX` escapes decoded, and
 * every base64 run in it is decoded and searched for key material and token
 * shapes: a secret escaped or encoded is the same secret.
 *
 * What this does NOT catch, and cannot without guessing:
 *
 *   - a password shorter than six characters, under any key;
 *   - a literal under a key that does not say it holds one (`DB_URL:` with no
 *     `user:password@` in it, `auth:` outside a docker `auths` object, a
 *     Secret's data under any other `kind`), and any token format not listed
 *     below;
 *   - a value this module takes for code: an identifier-shaped value that is
 *     a type (`password: String`), a call, a member access, or an identifier
 *     that itself names a secret (`password: hashedPassword`), and a plain
 *     lowercase word in a spaced form (`--password letmein`);
 *   - a syntax it does not parse: a YAML anchor's value (`password: &pw x`),
 *     a value continued with `\` or folded over several plain lines, a short
 *     flag glued to its value (`mysql -pX`), a heredoc, a string built by
 *     concatenation;
 *   - an encoding other than one base64 layer or a `\u` escape: hex,
 *     gzip, base64 of base64 — and in a decoded run only key material and
 *     token shapes are looked for, never a `password=` assignment.
 *
 * Those are why the name rules, the git-tracked rule and the caps in
 * `snapshot.ts` exist beside this one.
 */

import {
  CREDENTIAL_SHAPES,
  placeholderPassword,
  placeholderShape,
  placeholderToken,
  type CredentialShape,
} from '../../core/secrets/shapes.js'

/**
 * The credential shapes live in `core/secrets/shapes.ts`, beside the
 * placeholder shapes they are judged with, so that stage 8's discovery holds
 * a field to the very shapes this filter withholds a file for. Re-exported,
 * so a reader of this module still finds them here.
 */
export { CREDENTIAL_SHAPES, type CredentialShape }

/**
 * Which rule found it. `snapshot.ts` turns each into the reason a model reads,
 * and that reason names the CLASS, never the value: quoting the secret to
 * explain why the secret was withheld would be the whole defect again.
 */
export type SecretClass = 'key-material' | 'assigned' | 'shaped'

/**
 * Key material, in the shapes it actually ships in. Any match withholds the
 * file: a key has no placeholder form worth reading around.
 *
 * The rule was one case-sensitive plaintext PEM header, and it let through a
 * lowercase header, a PuTTY key, an OpenVPN static key, and a PEM body whose
 * header had been stripped. `[A-Z0-9 ]` covers RSA, DSA, EC, OPENSSH and PGP
 * headers without letting the wildcard run to the end of a file. Each
 * alternative is a fixed marker rather than a guess about entropy: a false
 * positive costs a file that is named in `skipped` and not read, and a false
 * negative costs a key sent to a third party.
 *
 * `-----BEGIN` in base64 is the fixed prefix `LS0tLS1CRUdJT` only when it
 * starts on a three-byte boundary, which is where a Kubernetes Secret or a
 * kubeconfig puts it. Inside a longer base64 stream it starts at any byte, and
 * the other two alignments encode it as `0tLS0tQkVHSU` and `tLS0tLUJFR0lO`
 * (review, security-2) — each is the part of the encoding that no neighbouring
 * byte can change.
 *
 * A body whose header was stripped is known by the first bytes of its DER,
 * which a private key's structure fixes: a PKCS#8 key opens on a SEQUENCE and
 * the version `0` followed by an algorithm (`MII…IBADAN`, `MIG…AgEA`, and
 * Ed25519's `MC4CAQAwBQYDK2Vw`), a PKCS#1 RSA key on the version and its
 * modulus (`MII…IBAAKC`), a SEC1 EC key on version `1` and an OCTET STRING
 * (`MHcCAQEE`, `MIGkAgEBBD`), and an OpenSSH key on its magic
 * (`b3BlbnNzaC1rZXktdjE`). A certificate and a public
 * key open on a nested SEQUENCE, never on a version, so none of them matches.
 */
const KEY_MATERIAL: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/i,
  /LS0tLS1CRUdJT/,
  /0tLS0tQkVHSU/,
  /tLS0tLUJFR0lO/,
  /PuTTY-User-Key-File-/i,
  /-----BEGIN OpenVPN Static key/i,
  /^[ \t]*(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+) AAAA/m,
  /\bMII[A-Za-z0-9+/]{3}IBA(?:DAN|AKC)/,
  /\bMIG[A-Za-z0-9+/]AgEA(?:MBMG|MBAG|MA0G)/,
  /\bMC4CAQAwBQYDK2Vw/,
  /\bM(?:HcC|HQC)AQEE|\bMIGkAgEBBD/,
  /b3BlbnNzaC1rZXktdjE/,
]

/**
 * YAML syntax that stands where a value would, recognised only unquoted and
 * after `:` — a quoted `"!x"` or `"*x"` is a string, and `PASSWORD=*x` is not
 * YAML. A tag is one of the names that resolve elsewhere (Ansible's `!vault`,
 * CloudFormation's `!Ref` and `!Sub`, Home Assistant's `!secret`), never any
 * word after a `!`; an alias is `*name`.
 */
const YAML_TAG =
  /^!(?:vault|ref|sub|getatt|importvalue|findinmap|join|select|split|if|equals|secret|env_var|env|include|reference|encrypted)$/i
const YAML_ALIAS = /^\*[\w.-]+$/

/**
 * Types a declaration names where a value would be: `password: string`,
 * `password: String!`, `password VARCHAR(255)`. Unquoted only.
 */
const TYPE_NAME =
  /^(?:string|str|int|integer|number|bool|boolean|bytes|buffer|any|unknown|object|char|text|varchar|bytea|blob|uuid|secretstr|secretstring|securestring)[!?]?$/i

/**
 * An unquoted value that is code rather than a literal: a call, a subscript or
 * a generic (`generateToken(user`, `Optional[str`, `Secret<String`), a member
 * access of letters (`config.apiKey`), or an identifier that names a secret
 * itself (`hashedPassword`, `access_token`) — a variable holding one, not one.
 */
const CALL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*[([<]/
const MEMBER = /^[a-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)+$/

function codeValue(value: string): boolean {
  if (TYPE_NAME.test(value) || CALL.test(value) || MEMBER.test(value)) return true
  if (!/^[a-z][A-Za-z_]*$/.test(value)) return false
  const words = wordsOf(value)
  return words.length >= 2 && words.some((word) => SECRET_WORDS.has(word) || SECRET_SUFFIX.test(word))
}

/** A plain lowercase word: in a spaced form it is the next word of a sentence, not a value. */
const PROSE_WORD = /^[a-z]+[.,;:!?]?$/

/** How the value was written, which decides what shapes count as syntax. */
interface Written {
  readonly quoted: boolean
  /** The operator that joined key and value; YAML's syntax exists only after `:`. */
  readonly separator: string
}

const placeholderValue = (value: string, written: Written): boolean => {
  if (placeholderShape(value)) return true
  if (written.quoted) return false
  if (written.separator === ':' && (YAML_TAG.test(value) || YAML_ALIAS.test(value))) return true
  return codeValue(value)
}

/** A secret shorter than this is not told from a word; the rule was six before this module. */
const MINIMUM_LITERAL = 6

/**
 * Words that say an identifier NAMES A SECRET VALUE when they end it:
 * `DB_PASSWORD`, `clientSecret`, `GITHUB_TOKEN`, `apikey`. `secrets`, plural,
 * is absent: in a workflow it is a collection (`secrets: inherit`), not a
 * value.
 */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'passphrase',
  'secret',
  'token',
  'credential',
  'credentials',
  'apikey',
  'secretkey',
  'accesskey',
  'privatekey',
  'authtoken',
  'accesstoken',
  'clientsecret',
])

/**
 * The same words closing a longer one: `DBPASSWORD`, `jwtsecret`,
 * `refreshtoken`, `adminpassword` are each one word, and whole-word matching
 * read every one of them (review). A suffix, never a substring, so
 * `tokenizer` and `passwordless` stay what they are.
 */
const SECRET_SUFFIX =
  /(?:password|passwd|passphrase|secret|token|apikey|secretkey|accesskey|privatekey|credentials?)$/

/** The one-word names that end like a secret and are not one: a library. */
const NOT_A_SECRET = new Set(['jsonwebtoken'])

/** `<kind>_key` is a secret for these kinds, and `key` alone is not: `key: password` names a key. */
const KEY_KINDS = new Set([
  'api',
  'access',
  'secret',
  'private',
  'signing',
  'encryption',
  'master',
  'auth',
  'app',
  'license',
  'account',
  'subscription',
  'shared',
])

/**
 * An identifier as its words: `existingSecretPasswordKey` → existing, secret,
 * password, key; `AWS_SECRET_ACCESS_KEY` → aws, secret, access, key;
 * `APIKey` → api, key.
 */
function wordsOf(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

/**
 * Whether an identifier names a secret VALUE. Generous, because a doubt here
 * costs a file, and the only NOs are the ones a reviewer could name:
 *
 *   - An identifier with `/` or `@` in it is a package or a path —
 *     `"@octokit/auth-token": "^4.0.0"` — never a variable.
 *   - `existing…` is the Helm and Bitnami convention for the NAME of a
 *     Kubernetes Secret that already exists: `existingSecret: billing-db`
 *     holds no secret, and withholding a chart's values for it lost the
 *     chart (review, gap-init-real-repos-4).
 *   - `jsonwebtoken` is a library (the same finding).
 *   - Otherwise the LAST word decides, as a word or as its suffix:
 *     `password_min_length`, `token_url` and `secretName` end on what they
 *     are about, and none is a secret; `DBPASSWORD` ends on `password`.
 */
function namesASecret(identifier: string): boolean {
  if (/[/@]/.test(identifier)) return false
  const words = wordsOf(identifier)
  if (words.includes('existing')) return false
  const last = words.at(-1)
  const before = words.at(-2)
  if (last === undefined || NOT_A_SECRET.has(last)) return false
  if (SECRET_WORDS.has(last) || SECRET_SUFFIX.test(last)) return true
  // `DB_PWD`, never `PWD` alone: that is the shell's working directory.
  if (last === 'pwd' && before !== undefined) return true
  if (last === 'key' && before !== undefined && KEY_KINDS.has(before)) return true
  // Rails' `secret_key_base`, and a `…_token_value`.
  if ((last === 'base' || last === 'value') && words.some((word) => SECRET_WORDS.has(word))) {
    return true
  }
  return false
}

/**
 * The key half of `key: value`, `key = value`, `"key": "value"`,
 * `key => value`, `key := value`, `config['key'] = value`, `--key=value` and
 * `-Dkey=value` — the assignment forms of YAML, JSON, TOML, INI, shell,
 * Python, Ruby, PHP, Go, a command line and a JVM. The value is read by
 * `valueAt`, which knows about quotes and next lines.
 *
 * A key starts where an identifier does, or after the `-` or `--` of a flag.
 * Not after any `-`: `a-a-a-…` would then start a key at every letter, each
 * running to the end of the line, and the scan would be quadratic. The key is
 * not bounded — a long key would otherwise walk past the rule — and need not
 * be, for the same reason.
 */
const ASSIGNMENT =
  /(?:(?<![\w@/.-])|(?<=(?:^|[\s"'(=[,])--?))(["']?)([A-Za-z_][\w./@-]*)\1\]?([ \t]*)(:=|=>|[?+]?=|:)([ \t]*)/gm

/** The most of a value a literal is judged on; also what keeps each step bounded. */
const VALUE_LIMIT = 256

const UNQUOTED = new RegExp(`[^\\s"'\`,;}\\])]{0,${VALUE_LIMIT}}`, 'y')

/**
 * After `key:` at the end of a line, the value can sit on the next: YAML's
 * plain or block scalar (`password: |`), a JSON pretty-printer's wrap. It
 * belongs to the key only when that line is indented deeper; a nested mapping
 * or a sequence is not a value.
 */
const LINE_END = /(?:[|>][-+0-9]{0,2})?[ \t]*(?:#[^\n]{0,256})?\r?\n([ \t]*)/y
const NESTED = /(?:-[ \t]|["']?[\w.-]{1,128}["']?[ \t]*:(?:[ \t]|\r?\n|$))/y

interface Value extends Written {
  readonly text: string
  /** Where the value starts, so the scan can resume INSIDE it. */
  readonly start: number
}

/** The indentation of the line `at` sits on. */
function indentAt(text: string, at: number): number {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  let index = lineStart
  while (text[index] === ' ' || text[index] === '\t') index += 1
  return index - lineStart
}

/** A quoted value, to its closing quote and no further than the limit: `"Tr0,ub;x y"` is one value. */
function quotedAt(text: string, at: number): string {
  const quote = text[at]
  let value = ''
  for (let index = at + 1; index < text.length && index - at <= VALUE_LIMIT; index += 1) {
    const character = text[index]
    if (character === quote || character === '\n') break
    if (character === '\\' && quote !== "'") {
      value += text[index + 1] ?? ''
      index += 1
      continue
    }
    value += character
  }
  return value
}

function valueAt(text: string, at: number, keyAt: number, separator: string): Value | undefined {
  let start = at
  if (separator === ':') {
    LINE_END.lastIndex = at
    const end = LINE_END.exec(text)
    if (end !== null) {
      const indent = (end[1] ?? '').length
      if (indent <= indentAt(text, keyAt)) return undefined
      start = LINE_END.lastIndex
      NESTED.lastIndex = start
      if (NESTED.test(text)) return undefined
    }
  }
  const opening = text[start]
  if (opening === '"' || opening === "'" || opening === '`') {
    return { text: quotedAt(text, start), quoted: true, separator, start: start + 1 }
  }
  UNQUOTED.lastIndex = start
  const unquoted = UNQUOTED.exec(text)?.[0] ?? ''
  return { text: unquoted, quoted: false, separator, start }
}

/**
 * Whether an unquoted value is code the line around it shows: a statement
 * (`password = hashed;`, spaces around the `=` and a `;` after), or the
 * README's `The token: generated by the CLI.` — a key after a word, and a
 * plain word after it followed by more.
 */
function codeOrProse(text: string, key: RegExpExecArray, value: Value): boolean {
  if (value.quoted) return false
  const after = text.slice(value.start + value.text.length, value.start + value.text.length + 64)
  const [, , , spaceBefore = '', separator = '', spaceAfter = ''] = key
  if (
    separator === '=' &&
    spaceBefore !== '' &&
    spaceAfter !== '' &&
    /^[A-Za-z_$][\w$]*$/.test(value.text) &&
    after.startsWith(';')
  ) {
    return true
  }
  if (separator !== ':' || !/^[a-z]+$/.test(value.text) || !/^[ \t]+[A-Za-z]/.test(after)) return false
  const back = text.slice(Math.max(0, key.index - 64), key.index)
  return /[A-Za-z][ \t]+$/.test(back.slice(back.lastIndexOf('\n') + 1))
}

const literal = (value: string | undefined, written: Written, minimum = MINIMUM_LITERAL): boolean =>
  value !== undefined && value.length >= minimum && !placeholderValue(value, written)

const UNQUOTED_SPACED: Written = { quoted: false, separator: ' ' }

/**
 * A value in a spaced form — a flag, a `.properties` line, a netrc — which a
 * sentence also is, and so is a Go field: `Token *oauth2.Token`,
 * `Secret []byte`.
 */
const spacedLiteral = (value: string | undefined): boolean =>
  value !== undefined &&
  !PROSE_WORD.test(value) &&
  !/^(?:\*|\[\]|&)+[A-Za-z_][\w.]*$/.test(value) &&
  literal(value, UNQUOTED_SPACED)

/** Every `key: value` in the text, each examined, including one nested in another's value. */
function assignsALiteral(text: string): boolean {
  const pattern = new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const identifier = match[2] ?? ''
    const separator = match[4] ?? ''
    const end = match.index + match[0].length
    const value = namesASecret(identifier) ? valueAt(text, end, match.index, separator) : undefined
    if (value !== undefined && literal(value.text, value) && !codeOrProse(text, match, value)) {
      return true
    }
    // Resumed at the value, not after it: `url: jdbc:…?user=app&password=x`
    // is one value holding the assignment that matters, and `matchAll`
    // would have stepped over it.
    pattern.lastIndex = Math.max(value?.start ?? end, match.index + 1)
  }

  for (const found of text.matchAll(AUTHORIZATION)) {
    if (literal(found[1], UNQUOTED_SPACED, 8)) return true
  }
  for (const rule of QUOTED_ASSIGNMENTS) {
    for (const found of text.matchAll(rule)) {
      if (literal(found[1], { quoted: true, separator: ' ' })) return true
    }
  }
  for (const found of text.matchAll(XML_ELEMENT)) {
    const value = found[2]?.trim()
    if (namesASecret(found[1] ?? '') && literal(value, { quoted: true, separator: '>' })) return true
  }
  for (const found of text.matchAll(XML_ADD)) {
    if (namesASecret(found[1] ?? '') && literal(found[2], { quoted: true, separator: '=' })) return true
  }
  for (const rule of SPACED_ASSIGNMENTS) {
    for (const found of text.matchAll(rule)) {
      const [, key = '', value] = found
      if ((key === '' || namesASecret(key)) && spacedLiteral(value)) return true
    }
  }
  for (const found of text.matchAll(CURL_USER)) {
    const password = found[1]
    if (password !== undefined && password !== '' && !placeholderPassword(password)) return true
  }
  for (const found of text.matchAll(ODBC_PWD)) {
    if (literal(found[1] ?? found[2], UNQUOTED_SPACED)) return true
  }
  return kubernetesSecretData(text) || jsonSecretData(text)
}

/**
 * `Authorization: Bearer …`, in a header, a curl line or a log. The scheme is
 * stepped over, so `Bearer ${TOKEN}` is judged on `${TOKEN}` — the rule this
 * replaced took `Bearer` itself for the literal.
 */
const AUTHORIZATION =
  /\bauthorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|bot)[ \t]+)?([^\s"'`,;}\]]{1,256})/gi

/**
 * Assignments whose value is quoted and whose key is not joined to it by `:`
 * or `=`, each by the file it exists for:
 *
 *   - `CREATE USER app WITH PASSWORD 'x'`, and MySQL's `IDENTIFIED BY 'x'` —
 *     the init script a Docker entrypoint leaves in a repository;
 *   - `define('DB_PASSWORD', 'x')` — `wp-config.php`, whose `AUTH_KEY`,
 *     `NONCE_SALT` and their kind are secrets by any name, so the constant is
 *     matched on a fragment rather than on its last word. Both sides of the
 *     fragment are bounded: unbounded, `define('keykeykey…` backtracked for
 *     over a second on one 64 KiB line (review).
 */
const QUOTED_ASSIGNMENTS: readonly RegExp[] = [
  /\bpassword\s+'([^'\n]{1,256})'/gi,
  /\bidentified\s+by\s+'([^'\n]{1,256})'/gi,
  /\bdefine\s*\(\s*["'][^"'\n]{0,128}?(?:pass(?:wd|word)?|secret|key|token|salt)[^"'\n]{0,128}["']\s*,\s*["']([^"'\n]{1,256})["']/gi,
]

/**
 * `<password>x</password>` — Maven's `settings.xml`, a Tomcat realm, any XML
 * whose element names a secret; the tag is judged by `namesASecret`, so
 * `<tokenizer>` is not one.
 */
const XML_ELEMENT = /<([A-Za-z_][\w.:-]{0,63})(?:[ \t][^<>]{0,256})?>([^<]{1,256})<\/\1>/g

/** .NET's `<add key="ApiKey" value="x"/>`: the name and the value are two attributes. */
const XML_ADD = /<add\s+(?:key|name)\s*=\s*"([^"]{1,128})"\s+value\s*=\s*"([^"]{0,256})"/gi

/**
 * The spaced forms, each with its key in group 1 (judged by `namesASecret`)
 * or none, and its value in group 2:
 *
 *   - `--password X`, a flag and its value;
 *   - `db.password X` alone on a line: a `.properties` file may separate them
 *     with a space, and a `.netrc` puts `password X` on a line of its own;
 *   - `machine h login u password X`: a `.netrc` on one line;
 *   - `ENV DB_PASSWORD X`: a Dockerfile's older form of `ENV`, which takes a
 *     space where the newer takes `=`.
 *
 * A plain lowercase word after the key is a sentence going on (`the --token
 * flag`), and is read.
 */
const SPACED_ASSIGNMENTS: readonly RegExp[] = [
  /(?:^|[\s"'])--?([A-Za-z][\w.-]{0,63})[ \t]+["']?([^\s"'`-][^\s"'`]{0,255})/gm,
  /^[ \t]*([A-Za-z_][\w.-]{0,127})[ \t]+([^\s=:"'][^\s]{0,255})[ \t]*$/gm,
  /\b(?:machine|default)\b[^\n]{0,256}?[ \t]()password[ \t]+(\S{1,256})/gi,
  /^[ \t]*ENV[ \t]+([A-Za-z_]\w{0,127})[ \t]+["']?([^\s"'][^"'\n]{0,255}?)["']?[ \t]*$/gm,
]

/** `curl -u user:password`: the password half, held to the URL's test. */
const CURL_USER = /\bcurl\b[^\n]{0,512}?[ \t](?:-u|--user)[ \t]+["']?[^\s:"']{0,128}:([^\s"']{0,256})/gi

/**
 * `…;Pwd=x;` — an ODBC connection string. After a `;`, or first on a line that
 * names another of the string's keys: `PWD=/home/app` on its own is the
 * shell's working directory, and the rule this replaced withheld it.
 */
const ODBC_PWD =
  /;[ \t]*pwd[ \t]*=[ \t]*([^;\s'"]{1,256})|^[ \t]*pwd[ \t]*=[ \t]*([^;\s'"]{1,256});(?=[^\n]{0,512}\b(?:uid|user id|server|database|driver|dsn|data source)[ \t]*=)/gim

/**
 * A Kubernetes `kind: Secret` whose `data` or `stringData` holds a literal.
 * Its values are base64 or plain, under keys that are whatever the author
 * chose (`url`, `dsn`, `config.json`), so no key rule reaches them and the
 * item's kind is the only signal.
 *
 * Judged one MAPPING at a time, wherever it sits: at the top of a document,
 * or as an item of a `kind: List`, with `data` before or after `kind`. The
 * rule this replaced knew only `kind: Secret` at column 0 (review). A
 * ConfigMap beside it is not taken for one, and a Helm template whose values
 * are all `{{ … }}` is read.
 */
const SECRET_KIND = /^([ \t]*)(-[ \t]+)?["']?kind["']?[ \t]*:[ \t]*["']?Secret["']?[ \t]*(?:#.*)?$/

function kubernetesSecretData(text: string): boolean {
  if (!/kind/.test(text)) return false
  const lines = text.split(/\r?\n/)
  const lead = (line: string): number => line.length - line.trimStart().length
  const quiet = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#')

  for (const [at, line] of lines.entries()) {
    const kind = SECRET_KIND.exec(line)
    if (kind === null) continue
    const column = (kind[1] ?? '').length + (kind[2] ?? '').length

    let first = at
    if (kind[2] === undefined) {
      for (let index = at - 1; index >= 0; index -= 1) {
        const above = lines[index] ?? ''
        if (quiet(above)) continue
        if (above.startsWith('---')) break
        const item = /^([ \t]*)-[ \t]+/.exec(above)
        if (item !== null && item[0].length === column) {
          first = index
          break
        }
        if (lead(above) < column) break
        first = index
      }
    }

    let block: number | undefined
    for (let index = first; index < lines.length; index += 1) {
      const current = lines[index] ?? ''
      if (quiet(current)) continue
      if (index > first && (current.startsWith('---') || lead(current) < column)) break
      const content = index === first ? current.slice(column) : current.trimStart()
      const indent = index === first ? column : lead(current)
      if (block !== undefined && indent <= block) block = undefined
      if (block === undefined) {
        if (indent === column && /^(?:data|stringData):[ \t]*(?:#.*)?$/.test(content)) block = indent
        continue
      }
      const entry = /^["']?[\w.-]+["']?:[ \t]*(.*)$/.exec(content)
      const value = entry?.[1]?.trim().replace(/^["']|["']$/g, '')
      if (value !== undefined && literal(value, { quoted: true, separator: ':' }, 1)) return true
    }
  }
  return false
}

/**
 * The same, and a docker `config.json`, in JSON: a Secret written with
 * `"kind": "Secret"` (as `kubectl get -o json` prints it), and a registry's
 * `auths` entry, whose `auth` is base64 of `user:password` under a key no
 * name rule would call a secret. Parsed when the text parses, and walked to
 * any depth, so a Secret inside a List is found; a file that does not parse
 * (JSON with comments, a fragment) is held to the two patterns instead.
 */
const DOCKER_AUTH_KEYS = new Set(['auth', 'identitytoken', 'password', 'registrytoken'])

function jsonSecretData(text: string): boolean {
  if (!/["']kind["']\s*:\s*["']Secret["']|["']auths["']\s*:/.test(text)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return jsonFragmentData(text)
  }
  const literalIn = (values: unknown, keys?: ReadonlySet<string>): boolean =>
    typeof values === 'object' &&
    values !== null &&
    Object.entries(values).some(
      ([key, value]) =>
        (keys === undefined || keys.has(key.toLowerCase())) &&
        typeof value === 'string' &&
        literal(value, { quoted: true, separator: ':' }, 1),
    )
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 64 || typeof node !== 'object' || node === null) return false
    const record = node as Record<string, unknown>
    if (record['kind'] === 'Secret' && (literalIn(record['data']) || literalIn(record['stringData']))) {
      return true
    }
    const auths = record['auths']
    if (typeof auths === 'object' && auths !== null) {
      if (Object.values(auths).some((entry) => literalIn(entry, DOCKER_AUTH_KEYS))) return true
    }
    return Object.values(record).some((child) => visit(child, depth + 1))
  }
  return visit(parsed, 0)
}

/**
 * The same two, in JSON that does not parse: every `"data": {…}` object in a
 * text that names a Secret, and every `"auth"` after an `"auths"`. Each
 * pattern is consumed as it is matched, so the work is linear in the text.
 */
function jsonFragmentData(text: string): boolean {
  const quoted = { quoted: true, separator: ':' }
  if (/["']kind["']\s*:\s*["']Secret["']/.test(text)) {
    for (const object of text.matchAll(/["'](?:data|stringData)["']\s*:\s*\{([^{}]{0,65536})\}/g)) {
      for (const entry of (object[1] ?? '').matchAll(/:\s*["']([^"'\n]{1,256})["']/g)) {
        if (literal(entry[1], quoted, 1)) return true
      }
    }
  }
  const auths = text.search(/["']auths["']\s*:/)
  if (auths >= 0) {
    for (const entry of text.slice(auths).matchAll(/["'](?:auth|identitytoken)["']\s*:\s*["']([^"'\n]{1,256})["']/gi)) {
      if (literal(entry[1], quoted, 1)) return true
    }
  }
  return false
}

/** Every occurrence of every shape, each held to its placeholder test. */
function carriesAShape(text: string): boolean {
  for (const shape of CREDENTIAL_SHAPES) {
    for (const found of text.matchAll(shape.pattern)) {
      const value = found.groups?.['value']
      const placeholder =
        value === undefined ? placeholderToken(found[0]) : placeholderPassword(value)
      if (!placeholder) return true
    }
  }
  return false
}

/**
 * The text with its `\uXXXX` and `\xXX` escapes decoded, and `\/` as `/`: a
 * JSON file may write `sk-ant-…` and every shape above would miss it
 * (review). The same text when there is nothing to decode.
 */
function unescaped(text: string): string {
  if (!text.includes('\\')) return text
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/')
}

/**
 * Every base64 run long enough to hold a token, decoded: a ConfigMap's
 * `binaryData`, a docker `auth`, a CI variable pasted encoded. Decoded runs
 * are held to key material and token shapes only — a shape is a fact about a
 * token wherever it sits, while an assignment rule over decoded bytes would
 * be a guess over noise. Each run is decoded once, so the work is linear in
 * the text.
 */
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g

function* decodedRuns(text: string): Generator<string> {
  for (const run of text.matchAll(BASE64_RUN)) {
    yield Buffer.from(run[0], 'base64').toString('latin1')
  }
}

/**
 * The first class of secret this text holds, or `undefined` when it holds
 * none this module can see. Key material first, then an assignment, then a
 * token's shape — the order the reasons have always been given in, so a file
 * that holds more than one is named by the same reason as before.
 */
export function secretIn(text: string): SecretClass | undefined {
  const decoded = unescaped(text)
  const views = decoded === text ? [text] : [text, decoded]
  if (views.some((view) => KEY_MATERIAL.some((marker) => marker.test(view)))) return 'key-material'
  if (views.some(assignsALiteral)) return 'assigned'
  if (views.some(carriesAShape)) return 'shaped'
  for (const run of decodedRuns(decoded)) {
    if (KEY_MATERIAL.some((marker) => marker.test(run))) return 'key-material'
    if (carriesAShape(run)) return 'shaped'
  }
  return undefined
}
