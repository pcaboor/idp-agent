/**
 * Where credentials live, by name: moved here from
 * `context/project-fs/snapshot.ts`, unchanged in behaviour, so that the two
 * readers of a service's repository judge one path with one copy of the
 * lists. The snapshot reads them to withhold a file from a model; stage 8's
 * discovery read (`context/discovery/read.ts`) reads them to never open one,
 * and an architecture rule keeps either reader from loading the other.
 *
 * Pure: sets of lowercased names and one test of a lowercased name. Every
 * caller lowercases first — APFS and NTFS serve `ID_RSA` for `id_rsa`, so a
 * case-sensitive list is a list with a hole in it.
 */

/**
 * Directories holding credentials rather than code. `.git/` earns its place
 * twice: `config` carries a remote URL, which carries a token often enough,
 * and the object store is bytes no Inspector can use anyway.
 */
export const CREDENTIAL_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  '.gcloud',
  '.azure',
  '.terraform',
])

/**
 * Generated or vendored: someone else's code, or this project's own output.
 * Excluded for the budget rather than for secrecy — the caps are small and a
 * `dist/` sorted before `package.json` would spend them all before reaching the
 * manifest, which is the one file an Inspector genuinely needs.
 */
export const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
])

/**
 * Words that name a file's PURPOSE, matched as the stem rather than the whole
 * name, because every one of these shipped one token away from a listed name:
 * `secret.yml`, `secrets.toml`, `secrets.properties`, `credentials.json`,
 * `auth.json`, `kubeconfig.yaml`, `accessKeys.csv`.
 */
export const CREDENTIAL_STEMS: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'credential',
  'credentials',
  'auth',
  'kubeconfig',
  'accesskeys',
  'access-keys',
  'service-account',
  'serviceaccount',
  'vault',
  'passwd',
  'password',
  'passwords',
])

/** Private keys, by the names ssh-keygen actually writes. */
export const PRIVATE_KEY_NAMES: ReadonlySet<string> = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
])

/**
 * Credential files by name. Each one is a file whose entire purpose is to hold
 * a token: a registry auth, an FTP login, a Postgres password, a basic-auth
 * table, a git credential store.
 */
export const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  '.npmrc',
  '.yarnrc',
  '.netrc',
  '_netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  '.pypirc',
  '.dockercfg',
  '.s3cfg',
  '.boto',
  'credentials',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
])

/**
 * Extensions that carry key material or state. `.crt` and `.cer` are absent on
 * purpose: a certificate is public by construction. `.pem` is present because
 * it is not — a PEM file is as often a private key as a certificate.
 * `.tfvars` and `.tfstate` are Terraform's two plaintext secret stores, and
 * this is a tool for infrastructure repositories.
 */
export const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.p8',
  '.keystore',
  '.jks',
  '.ppk',
  '.asc',
  '.gpg',
  '.kdbx',
  '.tfvars',
  '.tfstate',
])

/**
 * Whether a lowercased file name is an environment file: `.env` anywhere in
 * the name, not anchored to the front. The rule was
 * `=== '.env' || startsWith('.env.')`, which read `.env` and let `prod.env`,
 * `secrets.env`, `docker.env`, `.flaskenv`, `env.local`, `.env~` and
 * `.env-local` through — every shape a real project actually uses.
 */
export function isEnvironmentName(lower: string): boolean {
  return /(^|[.\-_])env([.\-_~]|$)/.test(lower) || lower.includes('.env')
}
