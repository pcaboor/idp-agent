/**
 * Adversarial MEASUREMENT of `readProject`: one project, many candidate
 * secret-bearing files, one read. Report-only — the table on stdout is the
 * deliverable; nothing here fails on a leak.
 *
 * Every candidate carries a distinctive marker. After the read, a marker found
 * in any `files[].text` means the secret reached the model (LEAKED); a path
 * found in `skipped` means it was caught, and the reason is recorded.
 */
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProject } from '../../src/context/project-fs/snapshot.js'

interface Candidate {
  readonly id: string
  /** Project-relative, POSIX. */
  readonly path: string
  /** Found in any files[].text => the secret reached the model. */
  readonly marker: string
  /** File content; undefined when setup creates the entry as a symlink. */
  readonly content?: string
  readonly note?: string
}

const K8S_PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA/LEAK_k8s_tls/x\n-----END RSA PRIVATE KEY-----\n'
const K8S_B64 = Buffer.from(K8S_PEM, 'utf8').toString('base64')
const WORKTREE_GITDIR = '/Users/someone/work/main/.git/worktrees/feature'

const candidates: Candidate[] = [
  // 1. env files whose name does not START with `.env`
  { id: '1a', path: 'prod.env', marker: 'LEAK_prodenv', content: 'DATABASE_URL=postgres://app:LEAK_prodenv@db/app\n' },
  { id: '1b', path: 'secrets.env', marker: 'LEAK_secretsenv', content: 'STRIPE_SECRET=LEAK_secretsenv\n' },
  { id: '1c', path: 'docker.env', marker: 'LEAK_dockerenv', content: 'MYSQL_ROOT_PASSWORD=LEAK_dockerenv\n' },
  { id: '1d', path: '.flaskenv', marker: 'LEAK_flaskenv', content: 'FLASK_SECRET_KEY=LEAK_flaskenv\n' },
  { id: '1e', path: 'env.local', marker: 'LEAK_envlocal', content: 'API_KEY=LEAK_envlocal\n' },
  { id: '1f', path: '.env~', marker: 'LEAK_envtilde', content: 'API_KEY=LEAK_envtilde\n', note: 'editor backup of .env' },
  { id: '1g', path: '.env-local', marker: 'LEAK_envhyphen', content: 'API_KEY=LEAK_envhyphen\n', note: 'hyphen, not dot' },

  // 2. hidden FILES at the project root
  { id: '2a', path: '.terraformrc', marker: 'LEAK_terraformrc', content: 'credentials "app.terraform.io" {\n  token = "LEAK_terraformrc"\n}\n' },
  { id: '2b', path: '.my.cnf', marker: 'LEAK_mycnf', content: '[client]\nuser=root\npassword=LEAK_mycnf\n' },
  { id: '2c', path: '.bash_history', marker: 'LEAK_bashhistory', content: 'export AWS_SECRET_ACCESS_KEY=LEAK_bashhistory\nmysql -uroot -pLEAK_bashhistory\n' },
  { id: '2d', path: '.zsh_history', marker: 'LEAK_zshhistory', content: ': 1700000000:0;curl -H "Authorization: Bearer LEAK_zshhistory" https://api\n' },
  { id: '2e', path: '.psql_history', marker: 'LEAK_psqlhistory', content: "CREATE USER app WITH PASSWORD 'LEAK_psqlhistory';\n" },
  { id: '2f', path: '.mysql_history', marker: 'LEAK_mysqlhistory', content: "SET PASSWORD FOR 'root'@'localhost' = PASSWORD('LEAK_mysqlhistory');\n" },
  { id: '2g', path: '.curlrc', marker: 'LEAK_curlrc', content: 'user = "admin:LEAK_curlrc"\n' },
  { id: '2h', path: '.wgetrc', marker: 'LEAK_wgetrc', content: 'http_user = admin\nhttp_password = LEAK_wgetrc\n' },
  { id: '2i', path: '.gitconfig', marker: 'LEAK_gitconfig', content: '[github]\n\ttoken = LEAK_gitconfig\n[credential]\n\thelper = store\n' },
  { id: '2j', path: '.npmrc.bak', marker: 'LEAK_npmrcbak', content: '//registry.npmjs.org/:_authToken=LEAK_npmrcbak\n' },
  { id: '2k', path: '.sentryclirc', marker: 'LEAK_sentry', content: '[auth]\ntoken=LEAK_sentry\n' },
  { id: '2l', path: '.vault_pass', marker: 'LEAK_vaultpass', content: 'LEAK_vaultpass\n', note: 'ansible vault password file' },
  { id: '2m', path: '.yarnrc.yml', marker: 'LEAK_yarnberry', content: 'npmAuthToken: LEAK_yarnberry\n', note: 'yarn 2+; .yarnrc is listed, .yarnrc.yml is not' },
  { id: '2n', path: '.gitlab-ci.yml', marker: 'LEAK_gitlabci', content: 'variables:\n  AWS_SECRET_ACCESS_KEY: LEAK_gitlabci\n' },

  // 3. terraform
  { id: '3a', path: 'terraform.rc', marker: 'LEAK_tfrcfile', content: 'credentials "app.terraform.io" {\n  token = "LEAK_tfrcfile"\n}\n' },
  { id: '3b', path: 'terraform.tfvars.json', marker: 'LEAK_tfvarsjson', content: '{"db_password": "LEAK_tfvarsjson"}\n' },
  { id: '3c', path: 'dev.auto.tfvars.json', marker: 'LEAK_autotfvarsjson', content: '{"db_password": "LEAK_autotfvarsjson"}\n' },

  // 4. secret-ish names near the listed ones
  { id: '4a', path: 'secrets/db.yml', marker: 'LEAK_secretsdir', content: 'password: LEAK_secretsdir\n', note: 'directory literally named secrets' },
  { id: '4b', path: 'secret.yml', marker: 'LEAK_secretsingular', content: 'password: LEAK_secretsingular\n' },
  { id: '4c', path: 'secrets.toml', marker: 'LEAK_secretstoml', content: '[db]\npassword = "LEAK_secretstoml"\n' },
  { id: '4d', path: 'secrets.properties', marker: 'LEAK_secretsprops', content: 'db.password=LEAK_secretsprops\n' },
  { id: '4e', path: 'config/secrets.yml.example', marker: 'LEAK_secretsexample', content: 'production:\n  secret_key_base: LEAK_secretsexample\n' },
  { id: '4f', path: 'secrets.yml', marker: 'LEAK_secretsyml', content: 'password: LEAK_secretsyml\n', note: 'CONTROL: exact listed name' },
  { id: '4g', path: 'credentials/aws.json', marker: 'LEAK_credsdir', content: '{"aws_secret_access_key": "LEAK_credsdir"}\n', note: 'credentials is a listed FILE name, not a directory' },
  { id: '4h', path: 'credentials.json', marker: 'LEAK_gcreds', content: '{"installed":{"client_secret":"LEAK_gcreds"}}\n', note: 'Google OAuth client download' },
  { id: '4i', path: 'auth.json', marker: 'LEAK_phpcomposer', content: '{"github-oauth":{"github.com":"LEAK_phpcomposer"}}\n', note: 'Composer' },
  { id: '4j', path: 'kubeconfig.yaml', marker: 'LEAK_kubeconfig', content: 'users:\n- name: admin\n  user:\n    client-key-data: LEAK_kubeconfig\n' },
  { id: '4k', path: 'accessKeys.csv', marker: 'LEAK_accesskeys', content: 'Access key ID,Secret access key\nAKIAIOSFODNN7EXAMPLE,LEAK_accesskeys\n', note: 'AWS console download' },
  { id: '4l', path: 'passwords.txt', marker: 'LEAK_passwordstxt', content: 'prod db: LEAK_passwordstxt\n' },

  // 5. Kubernetes Secret with a base64-encoded PEM
  { id: '5', path: 'k8s/secret.yaml', marker: K8S_B64, content: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: tls\ntype: kubernetes.io/tls\ndata:\n  tls.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==\n  tls.key: ${K8S_B64}\n`, note: 'marker is the base64 of a PEM block' },
  { id: '5b', path: 'config/jwt.yml', marker: 'LEAK_pembody', content: '# LEAK_pembody\nprivate_key: MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n', note: 'PEM body without header' },

  // 6. ordinary config files with credentials in them
  { id: '6a', path: 'config/database.yml', marker: 'LEAK_dbyml', content: 'production:\n  password: LEAK_dbyml\n' },
  { id: '6b', path: 'docker-compose.yml', marker: 'LEAK_compose', content: 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: LEAK_compose\n' },
  { id: '6c', path: 'src/main/resources/application.properties', marker: 'LEAK_props', content: 'spring.datasource.password=LEAK_props\n' },
  { id: '6d', path: 'config.json', marker: 'sk-LEAK_openai', content: '{"api_key": "sk-LEAK_openai"}\n' },
  { id: '6e', path: 'deploy.sh', marker: 'LEAK_aws', content: '#!/bin/sh\nexport AWS_SECRET_ACCESS_KEY=LEAK_aws\n' },
  { id: '6f', path: 'notes.md', marker: 'ghp_LEAK_github0000000000000000000000000', content: 'gh: ghp_LEAK_github0000000000000000000000000\nslack: xoxb-LEAK\njwt: eyJhbGciOiJIUzI1NiJ9.LEAK.sig\n' },
  { id: '6g', path: 'Dockerfile', marker: 'LEAK_dockerfile', content: 'FROM node:20\nENV API_KEY=LEAK_dockerfile\n' },
  { id: '6h', path: 'settings.py', marker: 'LEAK_django', content: "SECRET_KEY = 'LEAK_django'\n" },
  { id: '6i', path: 'wp-config.php', marker: 'LEAK_wp', content: "<?php\ndefine('DB_PASSWORD', 'LEAK_wp');\n" },
  { id: '6j', path: 'appsettings.json', marker: 'LEAK_dotnet', content: '{"ConnectionStrings":{"Default":"Server=db;Password=LEAK_dotnet"}}\n' },
  { id: '6k', path: 'gradle.properties', marker: 'LEAK_gradle', content: 'signing.password=LEAK_gradle\n' },
  { id: '6l', path: 'keystore.properties', marker: 'LEAK_android', content: 'storePassword=LEAK_android\n' },
  { id: '6m', path: 'group_vars/all.yml', marker: 'LEAK_ansible', content: 'db_password: LEAK_ansible\n' },
  { id: '6n', path: 'docker-entrypoint-initdb.d/init.sql', marker: 'LEAK_sql', content: "CREATE USER app WITH PASSWORD 'LEAK_sql';\n" },
  { id: '6o', path: 'logs/app.log', marker: 'LEAK_log', content: 'GET /x Authorization: Bearer LEAK_log\n' },

  // 7. `.git` as a FILE (worktree checkout)
  { id: '7', path: '.git', marker: WORKTREE_GITDIR, content: `gitdir: ${WORKTREE_GITDIR}\n`, note: 'absolute path outside the project' },

  // 8. .gitmodules with a token in the URL
  { id: '8', path: '.gitmodules', marker: 'LEAK_token', content: '[submodule "y"]\n\tpath = y\n\turl = https://user:LEAK_token@github.com/x/y.git\n' },

  // 9. CONTROLS that should be caught
  { id: '9a', path: 'id_rsa.bak', marker: 'LEAK_idrsabak', content: '-----BEGIN RSA PRIVATE KEY-----\nLEAK_idrsabak\n-----END RSA PRIVATE KEY-----\n', note: 'CONTROL' },
  { id: '9b', path: 'service-account.json', marker: 'LEAK_gcp', content: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nLEAK_gcp\\n-----END PRIVATE KEY-----\\n"}\n', note: 'CONTROL' },
  { id: '9c', path: 'mykey.txt', marker: 'LEAK_pgp', content: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nLEAK_pgp\n-----END PGP PRIVATE KEY BLOCK-----\n', note: 'CONTROL' },
  { id: '9d', path: 'certs/bundle.crt', marker: 'LEAK_crtbundle', content: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n-----BEGIN RSA PRIVATE KEY-----\nLEAK_crtbundle\n-----END RSA PRIVATE KEY-----\n', note: 'CONTROL: cert+key concatenated' },

  // 10. PuTTY key with a non-PEM header
  { id: '10', path: 'key.txt', marker: 'LEAK_putty', content: 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\nPublic-Lines: 2\nAAAA\nAAAA\nPrivate-Lines: 1\nLEAK_putty\nPrivate-MAC: 00\n' },
  { id: '10b', path: 'client.ovpn', marker: 'LEAK_ovpn', content: 'client\n<tls-auth>\n-----BEGIN OpenVPN Static key V1-----\nLEAK_ovpn\n-----END OpenVPN Static key V1-----\n</tls-auth>\n', note: 'mixed-case header' },

  // 11. PEM header forms
  { id: '11a', path: 'keys/deploy_key', marker: 'LEAK_openssh', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nLEAK_openssh\n-----END OPENSSH PRIVATE KEY-----\n', note: 'should match' },
  { id: '11b', path: 'keys/legacy.txt', marker: 'LEAK_lowercase', content: '-----begin rsa private key-----\nLEAK_lowercase\n-----end rsa private key-----\n', note: 'lowercase header' },

  // 12. workflow read on purpose
  { id: '12', path: '.github/workflows/deploy.yml', marker: 'LEAK_workflow', content: 'env:\n  AWS_SECRET_ACCESS_KEY: LEAK_workflow\n' },

  // 13. symlink chain out of the project (created in setup)
  { id: '13', path: 'link1', marker: 'LEAK_outside', note: 'link1 -> link2 -> ../outside/outside.txt' },

  // 14. directory symlink to a sibling directory holding a .env (created in setup)
  { id: '14a', path: 'viaLink/.env', marker: 'LEAK_siblingenv', note: 'viaLink -> sibling/' },
  { id: '14b', path: 'sibling/.env', marker: 'LEAK_siblingenv', content: 'API_KEY=LEAK_siblingenv\n' },
  { id: '14c', path: 'viaLink/app.ts', marker: 'OK_vialink', note: 'non-secret: proves the link was descended' },
]

const write = async (root: string, relative: string, content: string): Promise<void> => {
  const full = path.join(root, relative)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
}

describe('project-fs attack surface (measurement)', () => {
  it('reports which candidate secrets reach files[]', async () => {
    const outer = await mkdtemp(path.join(tmpdir(), 'idp-audit-'))
    const root = path.join(outer, 'project')
    await mkdir(root, { recursive: true })
    await mkdir(path.join(outer, 'outside'), { recursive: true })
    await writeFile(path.join(outer, 'outside', 'outside.txt'), 'LEAK_outside\n')

    for (const candidate of candidates) {
      if (candidate.content !== undefined) await write(root, candidate.path, candidate.content)
    }
    await write(root, 'sibling/app.ts', 'export const x = 1 // OK_vialink\n')
    await symlink('../outside/outside.txt', path.join(root, 'link2'))
    await symlink('link2', path.join(root, 'link1'))
    await symlink('sibling', path.join(root, 'viaLink'))
    // Positive controls: the links really do reach their targets on this disk.
    expect(await readFile(path.join(root, 'link1'), 'utf8')).toBe('LEAK_outside\n')
    expect(await readFile(path.join(root, 'viaLink/.env'), 'utf8')).toBe('API_KEY=LEAK_siblingenv\n')

    const snapshot = await readProject(root)

    const rows: string[] = []
    let leaked = 0
    let caught = 0
    let other = 0
    for (const candidate of candidates) {
      const carriers = snapshot.files.filter((f) => f.text.includes(candidate.marker)).map((f) => f.path)
      const read = snapshot.files.some((f) => f.path === candidate.path)
      const own = snapshot.skipped.find((s) => s.path === candidate.path)
      const ancestor = snapshot.skipped.find((s) => candidate.path.startsWith(`${s.path}/`))
      let verdict: string
      if (carriers.length > 0) {
        leaked += 1
        const via = carriers.length === 1 && carriers[0] === candidate.path ? '' : ` (via ${carriers.join(', ')})`
        verdict = `LEAKED${via}`
      } else if (own !== undefined) {
        caught += 1
        verdict = `caught: ${own.reason}`
      } else if (ancestor !== undefined) {
        caught += 1
        verdict = `caught (ancestor ${ancestor.path}): ${ancestor.reason}`
      } else if (read) {
        other += 1
        verdict = 'READ but marker not found in plain text'
      } else {
        other += 1
        verdict = 'ABSENT: neither read nor listed in skipped'
      }
      const note = candidate.note === undefined ? '' : `  [${candidate.note}]`
      rows.push(`${candidate.id.padEnd(4)} ${candidate.path.padEnd(44)} ${verdict}${note}`)
    }

    const k8s = snapshot.files.find((f) => f.path === 'k8s/secret.yaml')
    let k8sDecode = 'k8s/secret.yaml not in files'
    if (k8s !== undefined) {
      const b64 = /tls\.key: (\S+)/.exec(k8s.text)?.[1] ?? ''
      const decoded = Buffer.from(b64, 'base64').toString('utf8')
      k8sDecode = `k8s/secret.yaml IS in files; base64 decodes to a PEM containing LEAK_k8s_tls: ${decoded.includes('LEAK_k8s_tls')}; decoded header present: ${decoded.includes('-----BEGIN RSA PRIVATE KEY-----')}`
    }
    const allText = snapshot.files.map((f) => f.text).join('\n')
    const gitFile = `.git worktree pointer: absolute gitdir path reaches files[]: ${allText.includes(WORKTREE_GITDIR)}`

    const out = [
      '',
      '=== project-fs attack surface: results ===',
      `files read: ${snapshot.files.length}   skipped entries: ${snapshot.skipped.length}   truncated: ${snapshot.truncated}`,
      '',
      `${'id'.padEnd(4)} ${'candidate'.padEnd(44)} verdict`,
      '-'.repeat(120),
      ...rows,
      '-'.repeat(120),
      `LEAKED: ${leaked}   caught: ${caught}   other: ${other}   (of ${candidates.length})`,
      '',
      k8sDecode,
      gitFile,
      '',
      'files[] paths:',
      ...snapshot.files.map((f) => `  ${f.path}`),
      '',
      'skipped[]:',
      ...snapshot.skipped.map((s) => `  ${s.path}  <-  ${s.reason}`),
      '=== end ===',
      '',
    ]
    console.log(out.join('\n'))

    // Measurement only: the table is the deliverable.
    expect(true).toBe(true)
  })
})
