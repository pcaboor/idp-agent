import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_SHAPES, secretIn } from '../../src/context/project-fs/secrets.js'
import { readProject } from '../../src/context/project-fs/snapshot.js'

/**
 * What `project-fs` recognises as a secret in the text of a file, and what it
 * must not (review priority 7: security-1, security-2, gap-init-real-repos-4).
 *
 * NO REAL SECRET IS WRITTEN HERE. Every secret-shaped string is assembled at run
 * time: the issuer's prefix is split in two, and the body is generated from an
 * index. A secret scanner reading this file finds no token in it, and none of
 * these strings was ever a credential anyone issued.
 */

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const URL_SAFE = `${ALNUM}-_`
const BASE64 = `${ALNUM}+/`

/** A high-entropy-looking body, deterministic: 29 is coprime with every alphabet length used. */
const body = (length: number, alphabet = ALNUM, seed = 3): string =>
  Array.from({ length }, (_, index) => alphabet[(index * 29 + seed) % alphabet.length]).join('')

/** A prefix, joined from its halves so the source never spells it. */
const join = (...parts: string[]): string => parts.join('')

/** One of each shape the filter knows, as a line of an otherwise ordinary file. */
const SHAPES: Array<{ name: string; hit: string; misses: string[] }> = [
  {
    name: 'Anthropic API key',
    hit: `llm:\n  anthropic: ${join('sk-a', 'nt-api03-')}${body(93, URL_SAFE)}AA\n`,
    misses: [`The key looks like ${join('sk-a', 'nt-api03-')}... and goes in your shell.\n`],
  },
  {
    name: 'OpenAI project key',
    hit: `client = OpenAI("${join('sk-p', 'roj-')}${body(120, URL_SAFE)}")\n`,
    misses: [`# ${join('sk-p', 'roj-')}<your key>\n`, 'task-runner and risk-free-rate-model-2024\n'],
  },
  {
    name: 'OpenAI legacy key',
    hit: `openai.api_base = x  # ${join('s', 'k-')}${body(48)}\n`,
    misses: [`${join('s', 'k-')}short\n`],
  },
  {
    name: 'GitHub fine-grained token',
    hit: `remote: ${join('github', '_pat_')}${body(22)}_${body(59, ALNUM, 7)}\n`,
    misses: [`Create a ${join('github', '_pat_')}... token in the settings.\n`],
  },
  ...['p', 'o', 'u', 's', 'r'].map((letter) => ({
    name: `GitHub gh${letter}_ token`,
    hit: `auth ${join('g', `h${letter}_`)}${body(36)}\n`,
    misses: [
      `auth ${join('g', `h${letter}_`)}${'x'.repeat(36)}\n`,
      `auth ${join('g', `h${letter}_`)}${body(10)}\n`,
    ],
  })),
  {
    name: 'GitLab personal access token',
    hit: `git clone with ${join('glp', 'at-')}${body(20, URL_SAFE)}\n`,
    misses: [`${join('glp', 'at-')}${'x'.repeat(20)}\n`, `${join('glp', 'at-')}abc\n`],
  },
  ...['a', 'b', 'p', 'r'].map((letter) => ({
    name: `Slack xox${letter}- token`,
    hit: `slack ${join('xo', `x${letter}-`)}1234567890-9876543210-${body(24)}\n`,
    misses: [`slack ${join('xo', `x${letter}-`)}your-bot-token-here\n`],
  })),
  {
    name: 'AWS access key id',
    hit: `aws ${join('AK', 'IA')}${body(16, UPPER_DIGITS)}\n`,
    // The example key AWS prints in its own documentation, and one too short.
    misses: [`aws ${join('AK', 'IA')}IOSFODNN7${join('EXAM', 'PLE')}\n`, `aws ${join('AK', 'IA')}ABC\n`],
  },
  {
    name: 'AWS temporary access key id',
    hit: `aws ${join('AS', 'IA')}${body(16, UPPER_DIGITS, 5)}\n`,
    misses: [`${join('AS', 'IA')}${'X'.repeat(16)}\n`],
  },
  {
    name: 'Google API key',
    hit: `maps: ${join('AI', 'za')}${body(35, URL_SAFE)}\n`,
    misses: [`maps: ${join('AI', 'za')}${body(12)}\n`],
  },
  {
    name: 'Stripe live secret key',
    hit: `stripe ${join('sk_', 'live_')}${body(24)}\n`,
    misses: [`stripe ${join('sk_', 'live_')}...\n`],
  },
  {
    name: 'Stripe live restricted key',
    hit: `stripe ${join('rk_', 'live_')}${body(24, ALNUM, 9)}\n`,
    misses: [`stripe ${join('rk_', 'live_')}${'x'.repeat(24)}\n`],
  },
  {
    name: 'npm token',
    hit: `//registry: ${join('np', 'm_')}${body(36)}\n`,
    misses: ['npm_config_cache and npm_lifecycle_event are variables npm sets\n'],
  },
  {
    name: 'Hugging Face token',
    hit: `hub: ${join('h', 'f_')}${body(34, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')}\n`,
    misses: ['hf_hub_download and hf_transfer are library names\n'],
  },
  {
    name: 'Slack webhook',
    hit: `notify: https://${join('hooks.sl', 'ack.com')}/services/T${body(8, UPPER_DIGITS)}/B${body(8, UPPER_DIGITS, 2)}/${body(24)}\n`,
    misses: ['notify: https://api.slack.com/messaging/webhooks\n'],
  },
  {
    name: 'Azure storage account key',
    hit: `conn: DefaultEndpointsProtocol=https;AccountName=x;${join('Account', 'Key=')}${body(86, BASE64)}==;\n`,
    misses: ['conn: DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${STORAGE_KEY};\n'],
  },
  {
    name: 'private key PEM header',
    hit: `${join('-----BEGIN OPENSSH ', 'PRIVATE KEY-----')}\nb3BlbnNzaC1rZXktdjEAAAAA\n`,
    misses: [
      `${join('-----BEGIN ', 'PUBLIC KEY-----')}\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n`,
      `${join('-----BEGIN ', 'CERTIFICATE-----')}\nMIIDdzCCAl+gAwIBAgIE\n`,
    ],
  },
  {
    name: 'URL with a password in its userinfo',
    hit: `DATABASE_URL: postgres://billing:${join('Qx7', 'mPz2Lw9')}@db.internal:5432/billing\n`,
    misses: [
      'DATABASE_URL: postgres://billing:${DB_PASSWORD}@db.internal:5432/billing\n',
      'An example: postgres://user:password@localhost:5432/app\n',
      'git@github.com:acme/billing-api.git and http://localhost:8080/health\n',
    ],
  },
]

describe('every match is examined, not only the first (security-1)', () => {
  it.each([
    [
      'a substituted password, then a literal one',
      'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n' +
        `  pgadmin:\n    environment:\n      PGADMIN_DEFAULT_PASSWORD: ${join('Adm1n', 'Prod!')}\n`,
    ],
    ['changeme, then a literal', `password: changeme\n---\npassword: ${join('hunter', '2000')}\n`],
    ['a placeholder key, then a literal', `api_key: <your-key>\napi_key: ${body(32)}\n`],
    [
      'two SQL passwords',
      "CREATE USER a WITH PASSWORD 'changeme';\n" +
        `CREATE USER b WITH PASSWORD '${join('postgres', '-000')}';\n`,
    ],
    [
      'two PHP constants',
      "define('DB_PASSWORD', 'changeme');\n" + `define('AUTH_KEY', '${body(40)}');\n`,
    ],
    [
      "AWS's own example key, then a real-shaped one",
      `a: ${join('AK', 'IA')}IOSFODNN7${join('EXAM', 'PLE')}\nb: ${join('AK', 'IA')}${body(16, UPPER_DIGITS)}\n`,
    ],
    [
      'a substituted URL password, then a literal one',
      'a: postgres://app:${DB_PASSWORD}@db/app\n' + `b: postgres://app:${join('Qx7', 'mPz2Lw9')}@db/app\n`,
    ],
  ])('%s', (_label, text) => {
    expect(secretIn(text)).toBeDefined()
  })

  it('finds a literal under a key of any length, and one nested in another value', () => {
    // The value is bounded, so the scan can resume inside it; the key is not,
    // or a long enough name would walk past the rule.
    expect(secretIn(`${'A'.repeat(300)}_PASSWORD: ${join('hunter', '2000')}\n`)).toBe('assigned')
    expect(secretIn(`dsn: ${'x'.repeat(400)}?password=${join('hunter', '2000')}\n`)).toBe('assigned')
  })

  it('reads a file whose every match is a placeholder', () => {
    const text =
      'POSTGRES_PASSWORD: ${DB_PASSWORD}\npassword: changeme\napi_key: <your-key>\n' +
      "CREATE USER a WITH PASSWORD 'changeme';\n"
    expect(secretIn(text)).toBeUndefined()
  })

  it('withholds the mixed file from the snapshot, whole', async () => {
    // Withheld rather than redacted: a redaction is only as good as the span a
    // pattern found, and a model handed a file with holes in it reads it as
    // whole. A withheld file is named, and the Inspector reports its facts
    // unknown — recoverable; a key sent is not.
    const literal = join('Adm1n', 'Prod!')
    const root = await projectWith({
      'docker-compose.yml':
        'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n' +
        `  pgadmin:\n    environment:\n      PGADMIN_DEFAULT_PASSWORD: ${literal}\n`,
      'package.json': '{"name":"billing-api"}\n',
    })

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot)).not.toContain(literal)
    expect(snapshot.files.map((file) => file.path)).toEqual(['package.json'])
    expect(snapshot.skipped.find((one) => one.path === 'docker-compose.yml')?.reason).toBe(
      'excluded: a secret is assigned a literal value in it',
    )
  })
})

describe('the formats the deny list missed (security-2)', () => {
  it('keeps every shape as named data', () => {
    const names = CREDENTIAL_SHAPES.map((shape) => shape.name)
    expect(new Set(names).size).toBe(names.length)
    for (const shape of CREDENTIAL_SHAPES) {
      expect(shape.pattern.flags).toContain('g')
      expect(shape.why.length).toBeGreaterThan(0)
    }
  })

  describe.each(SHAPES)('$name', ({ hit, misses }) => {
    it('is detected', () => {
      expect(secretIn(hit)).toBeDefined()
    })
    it.each(misses)('its near miss is not: %s', (miss) => {
      expect(secretIn(miss)).toBeUndefined()
    })
  })

  it('finds a PEM header base64-encoded at any of the three alignments', () => {
    const header = join('-----BEGIN RSA ', 'PRIVATE KEY-----\n')
    for (const lead of ['', 'x', 'xy']) {
      const encoded = Buffer.from(`${lead}${header}MIIEow`).toString('base64')
      expect(secretIn(`blob: ${encoded}\n`), `lead of ${lead.length}`).toBe('key-material')
    }
  })

  it("finds a Kubernetes Secret's literal data, and reads a templated one", () => {
    const literal =
      'apiVersion: v1\nkind: Secret\nmetadata:\n  name: billing-db\ntype: Opaque\ndata:\n' +
      `  url: ${Buffer.from(join('postgres://', 'db/billing')).toString('base64')}\n`
    const templated =
      'apiVersion: v1\nkind: Secret\nmetadata:\n  name: {{ .Release.Name }}\ndata:\n' +
      '  url: {{ .Values.url | b64enc | quote }}\n'
    const configMap = '---\napiVersion: v1\nkind: ConfigMap\ndata:\n  LOG_LEVEL: debug\n'

    expect(secretIn(literal)).toBe('assigned')
    expect(secretIn(templated)).toBeUndefined()
    expect(secretIn(`${templated}${configMap}`)).toBeUndefined()
  })

  it('reads a JDBC password, an ODBC Pwd and a MySQL IDENTIFIED BY', () => {
    expect(secretIn(`url: jdbc:postgresql://db/app?user=app&password=${join('hunt', 'er2000')}\n`)).toBe(
      'assigned',
    )
    expect(secretIn(`Server=db;Database=app;Uid=app;Pwd=${join('hunt', 'er2000')};\n`)).toBe('assigned')
    expect(secretIn(`CREATE USER 'app'@'%' IDENTIFIED BY '${join('hunt', 'er2000')}';\n`)).toBe(
      'assigned',
    )
  })
})

describe('an ordinary manifest is not withheld (gap-init-real-repos-4)', () => {
  it.each([
    [
      'a package.json naming jsonwebtoken and @octokit/auth-token',
      JSON.stringify(
        {
          name: 'billing-api',
          dependencies: {
            jsonwebtoken: '^9.0.2',
            '@octokit/auth-token': '^4.0.0',
            'passport-http-bearer': '~1.0.1',
            keytar: '>=7.9.0',
            'local-lib': 'workspace:*',
          },
        },
        null,
        2,
      ),
    ],
    ['a Cargo.toml naming jsonwebtoken', '[dependencies]\njsonwebtoken = "9"\nsecrecy = "0.8"\n'],
    [
      'a Helm values file naming an existing Secret',
      'auth:\n  existingSecret: billing-db\n  existingSecretPasswordKey: password\n' +
        'tls:\n  secretName: billing-tls\nserviceAccount:\n  tokenExpirationSeconds: 3600\n',
    ],
    [
      'a Deployment reading its password from a secretKeyRef',
      'env:\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: billing-db\n        key: password\n',
    ],
    [
      'a README with placeholders',
      '```sh\nAPI_KEY=your-api-key\nexport GITHUB_TOKEN=<your-token>\nSECRET_KEY=your_secret_here\n```\n',
    ],
    [
      'a model configuration',
      'max_tokens: 1000\ntokenizer: cl100k_base\npassword_min_length: 12\n' +
        'token_url: https://auth.acme.internal/oauth/token\n',
    ],
    [
      'configuration reading the environment',
      "export default { password: process.env.DB_PASSWORD, key: import.meta.env.VITE_KEY }\n" +
        "SECRET_KEY = os.environ['SECRET_KEY']\ntoken = os.getenv('TOKEN')\n" +
        "'password' => env('DB_PASSWORD'),\n",
    ],
    ['a fetch call sending cookies', "fetch(url, { credentials: 'include' })\n"],
    [
      'a workflow passing its secrets on',
      'jobs:\n  deploy:\n    secrets: inherit\n    env:\n      TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n',
    ],
    ['an Authorization header built from a variable', 'curl -H "Authorization: Bearer ${TOKEN}" https://x\n'],
  ])('%s', (_label, text) => {
    expect(secretIn(text)).toBeUndefined()
  })

  it('reads the package.json of a typical Node API', async () => {
    // The review's case: the service's only manifest, lost for naming a library.
    const manifest = JSON.stringify(
      { name: 'billing-api', dependencies: { express: '^4.19.2', jsonwebtoken: '^9.0.2' } },
      null,
      2,
    )
    const root = await projectWith({ 'package.json': manifest })

    const snapshot = await readProject(root)

    expect(snapshot.files.map((file) => file.path)).toEqual(['package.json'])
  })
})

/**
 * What a reviewer found this filter reading, after the rewrite, that it must
 * withhold. Most of these main's first-match rule caught — an unanchored
 * `password\s*[:=]\s*…` — and the whole-word rewrite lost: a compound key in
 * one case, a flag, a value on the next line, a quoted value with punctuation,
 * a leading `!`, `@` or `*`. The rest neither caught: an XML element, a
 * subscript, a spaced flag, a credential URL with no user, a Secret written as
 * JSON, a docker `auths` entry, a base64 or `\u`-escaped token.
 */
describe('what a reviewer found read, and must be withheld', () => {
  // Assembled at run time: no secret scanner finds a literal in this file.
  const PW = join('Qx7', 'mPz2Lw9Kd')
  const b64 = (text: string): string => Buffer.from(text).toString('base64')

  it.each([
    // A compound key in one case: one word, never in a list of words. (main: caught)
    ['DBPASSWORD=', `DBPASSWORD=${PW}\n`],
    ['dbpassword:', `dbpassword: ${PW}\n`],
    ['jwtsecret:', `jwtsecret: ${PW}\n`],
    ['refreshtoken:', `refreshtoken: ${PW}\n`],
    ['sessionsecret:', `sessionsecret: ${PW}\n`],
    ['adminpassword:', `adminpassword: ${PW}\n`],
    // A flag or a JVM property: the key starts after `-`. (main: caught)
    ['--password=', `RUN mysqladmin -u root --password=${PW} ping\n`],
    ['--db-password=', `app --db-password=${PW}\n`],
    ['-Dspring…password=', `java -Dspring.datasource.password=${PW} -jar app.jar\n`],
    [
      '-D…password= in an exec-form ENTRYPOINT',
      `ENTRYPOINT ["java", "-Dspring.datasource.password=${PW}", "-jar", "app.jar"]\n`,
    ],
    // The value on the next line. (main: caught)
    ['a YAML value on the next line', `db:\n  password:\n    ${PW}\n`],
    ['a YAML block scalar', `db:\n  password: |\n    ${PW}\n`],
    ['a JSON value on the next line', `{\n  "password":\n    "${PW}"\n}\n`],
    // A leading `!`, `@`, `*`, or `example` inside: a literal, not syntax. (main: caught)
    ['a quoted value starting with !', `POSTGRES_PASSWORD: "!${PW}"\n`],
    ['an unquoted value starting with !', `password: !${PW}\n`],
    ['a value starting with @', `db_password = "@${PW}"\n`],
    ['a quoted value starting with *', `password: "*${PW}"\n`],
    ['a value starting with Example', `password: Example${PW}\n`],
    ['a value with ... inside', `password: ${PW.slice(0, 4)}...${PW.slice(4)}\n`],
    // A quoted value is taken to its closing quote, not to the first `,;)]}` or space.
    ['a comma inside quotes', `password: "Tr0,${PW}"\n`],
    ['a semicolon inside quotes', `DB_PASSWORD="Tr0u;${PW}"\n`],
    ['a space inside quotes', `password = "abc ${PW}"\n`],
    ['a leading $ that is no variable', `password: '$${PW}'\n`],
    ['a leading %', `password: '%${PW}'\n`],
    ['a leading (', `password: '(${PW}'\n`],
    // A credential URL with no user, a percent-encoded or `$` password, a `/` in it.
    ['redis://:password@host', `redis.url=redis://:${PW}@cache:6379/0\n`],
    ['a percent-encoded password', `DATABASE_URL=postgres://app:%40${PW}@db/app\n`],
    ['a password starting with $', `DATABASE_URL=postgres://app:$${join('Tr0ub-', '4dor.9zK')}@db/app\n`],
    ['a password holding /', `DATABASE_URL=postgres://app:ab/${PW}@db/app\n`],
    ['a password starting with !', `url: postgres://app:!${PW}@db/app\n`],
    // The syntaxes that are not `key<sep>value`.
    ['a Maven settings.xml <password>', `<server>\n  <id>nexus</id>\n  <password>${PW}</password>\n</server>\n`],
    ['a .NET <add key value>', `<appSettings>\n  <add key="ApiKey" value="${PW}" />\n</appSettings>\n`],
    ['a subscript assignment', `config['password'] = '${PW}'\n`],
    ['an ENV subscript', `ENV["DB_PASSWORD"] = "${PW}"\n`],
    ['a spaced flag', `tool --password ${PW} --host db\n`],
    ['a .properties space separator', `db.url jdbc:postgresql://db/app\ndb.password ${PW}\n`],
    ['a netrc line', `machine api.acme.io login app password ${PW}\n`],
    ['a netrc block', `machine api.acme.io\n  login app\n  password ${PW}\n`],
    ['curl -u', `curl -u admin:${PW} https://api.acme.io/x\n`],
  ])('%s', (_label, text) => {
    expect(secretIn(text)).toBeDefined()
  })

  it.each([
    [
      'a Secret written as JSON',
      JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db' }, data: { url: b64(`postgres://db/${PW}`) } }),
    ],
    [
      'a Secret inside a List',
      'apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: Secret\n' +
        `    metadata:\n      name: db\n    data:\n      url: ${b64(PW)}\n  - apiVersion: v1\n    kind: ConfigMap\n`,
    ],
    [
      'a Secret whose data comes before its kind',
      `- apiVersion: v1\n  data:\n    url: ${b64(PW)}\n  kind: Secret\n`,
    ],
    [
      'a docker config.json auth',
      JSON.stringify({ auths: { 'registry.acme.io': { auth: b64(`ci:${PW}`) } } }),
    ],
    [
      "a token's base64 under a ConfigMap",
      `apiVersion: v1\nkind: ConfigMap\ndata:\n  llm: ${b64(join('sk-a', 'nt-api03-') + body(93, URL_SAFE) + 'AA')}\n`,
    ],
    [
      'a token written with a JSON escape',
      `{"llm": {"anthropic": "\\u0073${join('k-a', 'nt-api03-')}${body(93, URL_SAFE)}AA"}}\n`,
    ],
    [
      'a PKCS#8 private key whose PEM header was stripped',
      `key: ${join('MIIEvQIBADAN', 'BgkqhkiG9w0BAQEFAASC')}${body(64, BASE64)}\n`,
    ],
    ['a PKCS#1 RSA private key, headerless', `${join('MIIEpAIBAA', 'KCAQEA')}${body(64, BASE64)}\n`],
    ['a SEC1 EC private key, headerless', `${join('MHcCAQE', 'EIB')}${body(40, BASE64)}\n`],
  ])('%s', (_label, text) => {
    expect(secretIn(text)).toBeDefined()
  })

  it.each([
    ['redis without a password', 'cache: redis://localhost:6379/0\n'],
    ['redis with a substituted password', 'cache: redis://:${REDIS_PASSWORD}@redis:6379\n'],
    ['a URL with a port, a path and an @', 'see http://localhost:3000/@vite/client and https://x.io:8443/users/@me\n'],
    ['a docker $VAR, upper case', 'POSTGRES_PASSWORD: $DB_PASSWORD\n'],
    ['a Maven property in <password>', '<password>${env.NEXUS_PASSWORD}</password>\n'],
    ['an XML tag that only contains token', '<tokenizer>cl100k_base</tokenizer>\n'],
    ['a subscript read from the environment', "config['password'] = os.environ['DB_PASSWORD']\n"],
    ['a spaced flag reading stdin', 'echo "$PW" | docker login --password-stdin ghcr.io\n'],
    ['a spaced flag named in prose', 'Pass the --password option, or --token flag.\n'],
    ['a docker -u user:group', 'docker run -u www-data:www-data app\n'],
    ['a YAML alias', 'db:\n  password: *db_password\n'],
    ['a vault tag', 'db:\n  password: !vault |\n    $ANSIBLE_VAULT;1.1;AES256\n'],
    ['a Maven filter token', 'db.password=@db.password@\n'],
    ['a whole placeholder word', 'password: example\ntoken: xxxxxxxx\napi_key: ...\n'],
    ['a nested mapping under a secret-named key', 'password:\n  min_length: 12\n  require_digit: true\n'],
    ['a sequence under a secret-named key', 'credentials:\n  - name: db\n'],
    ['a Secret inside a List, templated', 'kind: List\nitems:\n  - kind: Secret\n    data:\n      url: {{ .Values.url | b64enc }}\n'],
    ['an empty docker auth', JSON.stringify({ auths: { 'ghcr.io': {} }, credsStore: 'desktop' })],
    ['a public key and a certificate, headerless', 'a: MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\nb: MIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBa\n'],
  ])('reads %s', (_label, text) => {
    expect(secretIn(text)).toBeUndefined()
  })
})

describe('ordinary source is not withheld for naming a secret', () => {
  it.each([
    ['a TypeScript interface', 'interface C { password: string; token: string }\n'],
    ['a GraphQL type', 'type User { password: String! }\n'],
    ['a Rust struct', 'struct C { password: String }\n'],
    ['a Java request read', 'String password = request.getParameter("password");\n'],
    ['a call', 'const token = generateToken(user)\n'],
    ['a member access', 'const apiKey = config.apiKey\n'],
    ['an identifier naming a secret', 'user.password = hashedPassword\n'],
    ['a statement', 'String password = hashed;\n'],
    ['a Python signature', 'def login(password: str, token: Optional[str]):\n'],
    ['a SQL column', 'CREATE TABLE users (\n  password VARCHAR(255)\n);\n'],
    ['a README sentence', 'The token: generated by the CLI.\n'],
    ['an exact version pin', '{"dependencies": {"generate-password": "1.7.10"}}\n'],
    ["the shell's working directory", 'PWD=/home/app\nOLDPWD=/home\n'],
    ['a C# signature', 'Task Run(CancellationToken cancellationToken)\n'],
  ])('%s', (_label, text) => {
    expect(secretIn(text)).toBeUndefined()
  })
})

describe('no rule is slow on a hostile line', () => {
  // Each rule is a regular expression run over up to 64 KiB. One that
  // backtracks without bound turns 200 files into minutes before the
  // Inspector starts; `define('` followed by `keykeykey…` took 1.2 s.
  it.each([
    ['define', `define('${'key'.repeat(21_000)}`],
    ['hyphenated words', 'a-'.repeat(32_000)],
    ['keys without values', 'password:'.repeat(6_500)],
    ['flags without values', '--password '.repeat(6_000)],
    ['unclosed XML', '<password>'.repeat(6_500)],
    ['URL prefixes', 'redis://:'.repeat(7_000)],
    ['colons', 'a:'.repeat(32_000)],
    ['quotes', `password: "${'"'.repeat(60_000)}`],
    ['base64', 'QUJD'.repeat(16_000)],
    ['JSON escapes', '\\u0041'.repeat(10_000)],
  ])('%s', (_label, text) => {
    const started = performance.now()
    secretIn(text)
    expect(performance.now() - started).toBeLessThan(400)
  })
})

const projectWith = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'idp-secrets-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}
