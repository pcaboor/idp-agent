import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowed,
  BY_DESIGN,
  byDesignReason,
  discardedWhole,
  isCode,
  isGenerated,
  NOT_ANALYSED,
  neverOpened,
  notAnalysedReason,
  type Walked,
} from '../../src/core/discovery/allow.js'
import { blobId } from '../../src/core/git/blob.js'

/**
 * What stage 8's discovery read may open, decided by the path alone (plan,
 * Task 1.2): a closed allow-list of configuration files by name, behind the
 * snapshot's own lists of where credentials live, and a discard, after
 * parsing, of what can only be recognised by parsing it.
 *
 * NO REAL SECRET IS WRITTEN HERE: every path below is a name, never a file.
 */

/**
 * `head-unlisted` is said of `Walked`'s `unlisted` count, never beside a path:
 * typechecked by `pnpm typecheck`, which reads `tests/**`, so a path given it
 * fails the build rather than a review.
 */
if (Math.random() > 2) {
  const deleted: Walked['notAnalysed'][number] = { path: 'package.json', why: 'deleted' }
  // @ts-expect-error a HEAD not listed whole names no path: the reason is the count's
  const unlisted: Walked['notAnalysed'][number] = { path: 'package.json', why: 'head-unlisted' }
  void [deleted, unlisted]
}

describe('the discovery allow-list', () => {
  it.each([
    ['package.json', 'npm', 'json', 'evidence'],
    ['packages/api/package.json', 'npm', 'json', 'evidence'],
    ['examples/demo/package.json', 'npm', 'json', 'mention'],
    ['.env.example', 'env-file', 'dotenv', 'sample'],
    ['.env.sample', 'env-file', 'dotenv', 'sample'],
    ['.env.template', 'env-file', 'dotenv', 'sample'],
    ['.env.local.example', 'env-file', 'dotenv', 'sample'],
    ['config/.env.example', 'env-file', 'dotenv', 'sample'],
    ['test/fixtures/.env.example', 'env-file', 'dotenv', 'mention'],
    ['package-lock.json', undefined, undefined, undefined],
    ['.env', undefined, undefined, undefined],
    ['README.md', undefined, undefined, undefined],
    ['values.yaml', undefined, undefined, undefined],
    ['k8s/deployment.yaml', 'k8s', 'yaml', 'evidence'],
    ['deploy/app.yml', 'k8s', 'yaml', 'evidence'],
    ['manifests/x.yaml', 'k8s', 'yaml', 'evidence'],
    ['services/api/Kubernetes/base/worker.YAML', 'k8s', 'yaml', 'evidence'],
    ['test/fixtures/k8s/deployment.yaml', 'k8s', 'yaml', 'mention'],
    ['charts/x/templates/deployment.yaml', undefined, undefined, undefined],
    ['k8s/templates/a.yaml', undefined, undefined, undefined],
    ['charts/k8s/a.yaml', undefined, undefined, undefined],
    ['config/app.yaml', undefined, undefined, undefined],
    ['k8s/README.md', undefined, undefined, undefined],
    ['deployment.yaml', undefined, undefined, undefined],
  ])('opens only the allow-list, by name: %s', (file, extractor, format, standing) => {
    expect(allowed(file)).toEqual(extractor === undefined ? undefined : { extractor, format, standing })
  })

  it.each(['node_modules/pg/package.json', 'vendor/acme/package.json', 'dist/package.json'])(
    'tells a generated or vendored manifest from the service’s own: %s',
    (file) => {
      // The read asks this before the allow-list, so a committed dependency's
      // manifest is never read as the service's and never fills a cap.
      expect(isGenerated(file)).toBe(true)
      expect(isGenerated('package.json')).toBe(false)
    },
  )

  it.each([
    ['.env', 'environment-file'],
    ['.env.local', 'environment-file'],
    ['.env.production', 'environment-file'],
    ['prod.env', 'environment-file'],
    ['deploy/prod.env', 'environment-file'],
    ['id_rsa', 'key-material'],
    ['server.key', 'key-material'],
    ['cert.pem', 'key-material'],
    ['.aws/credentials', 'cloud-credentials'],
    ['.ssh/config', 'key-material'],
    ['.kube/config', 'kubeconfig'],
    ['kubeconfig.yaml', 'kubeconfig'],
    ['terraform.tfstate', 'terraform-state'],
    ['prod.tfvars', 'terraform-state'],
    ['.npmrc', 'credential-store'],
    ['.git-credentials', 'credential-store'],
  ])('never opens a credential by its path: %s', (file, why) => {
    expect(neverOpened(file)).toBe(why)
    expect(allowed(file)).toBeUndefined()
  })

  it.each([
    ['.ssh/package.json', 'key-material'],
    ['.SSH/package.json', 'key-material'],
    ['.aws/.env.example', 'cloud-credentials'],
    ['ID_RSA', 'key-material'],
    ['Secrets/package.json', 'credential-store'],
    ['.kube/k8s/a.yaml', 'kubeconfig'],
    ['k8s/kubeconfig.yaml', 'kubeconfig'],
  ])('rules a credential folder out before the allow-list, whatever its case: %s', (file, why) => {
    // APFS and NTFS serve `ID_RSA` for `id_rsa`: every name is lowercased first.
    expect(neverOpened(file)).toBe(why)
  })

  it('tells code from a format with no rule', () => {
    for (const file of ['src/index.ts', 'app.py']) {
      expect(isCode(file), file).toBe(true)
      expect(allowed(file), file).toBeUndefined()
    }
    for (const file of ['README.md', '.gitignore', 'Dockerfile']) {
      expect(isCode(file), file).toBe(false)
      expect(allowed(file), file).toBeUndefined()
      expect(neverOpened(file), file).toBeUndefined()
    }
  })

  it('discards whole what it must parse to recognise', () => {
    expect(discardedWhole('# encrypted\nDATABASE_URL=ENC[AES256_GCM,data:x]\nsops_version=3.8.1\n', 'dotenv')).toBe(
      'discarded-sops',
    )
    expect(discardedWhole('DATABASE_URL=postgres://localhost/app\n', 'dotenv')).toBeUndefined()
    expect(discardedWhole('{"name":"x","sops":{"version":"3.8.1"}}', 'json')).toBe('discarded-sops')
    expect(discardedWhole('{"name":"x","dependencies":{"pg":"^8"}}', 'json')).toBeUndefined()

    expect(discardedWhole('apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n', 'yaml')).toBe('discarded-secret')
    expect(discardedWhole('kind: SealedSecret\nmetadata:\n  name: db\n', 'yaml')).toBe('discarded-secret')
    expect(discardedWhole('data: ENC[AES256_GCM]\nsops:\n  version: 3.8.1\n', 'yaml')).toBe('discarded-sops')
    expect(discardedWhole('kind: ConfigMap\n---\nkind: Secret\n', 'yaml')).toBe('discarded-secret')
    expect(discardedWhole('kind: Deployment\n', 'yaml')).toBeUndefined()

    // A List is read for what its items are, never for what they say (2.4):
    // a Secret inside one is a Secret in the stream.
    const list = (items: string): string => `apiVersion: v1\nkind: List\nitems:\n${items}`
    expect(discardedWhole(list('  - kind: Deployment\n  - kind: Secret\n    stringData: { password: x }\n'), 'yaml')).toBe(
      'discarded-secret',
    )
    expect(discardedWhole(list('  - kind: SealedSecret\n'), 'yaml')).toBe('discarded-secret')
    expect(discardedWhole(list('  - kind: List\n    items:\n      - kind: Secret\n'), 'yaml')).toBe('discarded-secret')
    expect(discardedWhole(list('  - kind: ConfigMap\n    sops: { version: 3.8.1 }\n'), 'yaml')).toBe('discarded-sops')
    expect(discardedWhole('kind: SecretList\nitems:\n  - metadata: { name: db }\n', 'yaml')).toBe('discarded-secret')
    expect(discardedWhole(list('  - kind: Deployment\n'), 'yaml')).toBeUndefined()

    // A List that holds itself is a reading error, never a hang: Kubernetes'
    // decoder refuses an anchor that contains itself, and a walk of one never
    // ends. One item named twice holds nothing twice, and is read once.
    expect(discardedWhole('&a {kind: List, items: [*a]}\n', 'yaml')).toBe('parse-failure')
    expect(discardedWhole('&a\nkind: List\nitems:\n  - *a\n', 'yaml')).toBe('parse-failure')
    expect(discardedWhole('kind: Deployment\n---\n&a {kind: List, items: [*a]}\n', 'yaml')).toBe('parse-failure')
    expect(discardedWhole('d: &d {kind: Deployment}\nkind: List\nitems: [*d, *d]\n', 'yaml')).toBeUndefined()

    // A merge key is applied, as Kubernetes' decoder applies it: a Secret
    // merged into a document, or into a List's item, is a Secret, and a
    // document's own kind is the one it keeps. A merge Kubernetes refuses, or
    // one that holds itself, cannot be read whole.
    expect(discardedWhole('base: &b\n  kind: Secret\n<<: *b\nstringData:\n  password: x\n', 'yaml')).toBe('discarded-secret')
    expect(discardedWhole(list('  - <<: { kind: Secret }\n'), 'yaml')).toBe('discarded-secret')
    expect(discardedWhole('<<: { sops: { version: 3.8.1 } }\nkind: ConfigMap\n', 'yaml')).toBe('discarded-sops')
    expect(discardedWhole('<<: { kind: Secret }\nkind: ConfigMap\n', 'yaml')).toBeUndefined()
    expect(discardedWhole('<<: 3\nkind: Deployment\n', 'yaml')).toBe('parse-failure')
    expect(discardedWhole('&a {<<: *a, kind: List}\n', 'yaml')).toBe('parse-failure')

    // An alias bomb is a reading error, through `readDocuments`'s alias bound,
    // and never a hang: a stream that cannot be read whole cannot be shown to
    // hold no Secret, so nothing of it is read.
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
    for (let level = 1; level < 10; level += 1) {
      const before = String.fromCharCode(96 + level)
      const name = String.fromCharCode(97 + level)
      bomb.push(`${name}: &${name} [${Array(10).fill(`*${before}`).join(', ')}]`)
    }
    const started = Date.now()
    expect(discardedWhole(`${bomb.join('\n')}\n`, 'yaml')).toBe('parse-failure')
    expect(Date.now() - started).toBeLessThan(2_000)

    // A document count of its own bounds the file.
    expect(discardedWhole('---\nkind: ConfigMap\n'.repeat(100), 'yaml')).toBeUndefined()
    expect(discardedWhole('---\nkind: ConfigMap\n'.repeat(101), 'yaml')).toBe('parse-failure')
  })

  it('computes git’s blob id', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'idp-blob-'))
    execFileSync('git', ['init', '-q', '--object-format=sha1', repo])
    for (const text of ['', 'DATABASE_URL=postgres://localhost/app\n', '{\n  "name": "é"\n}']) {
      const bytes = Buffer.from(text, 'utf8')
      const expected = execFileSync('git', ['-C', repo, 'hash-object', '--stdin'], { input: bytes, encoding: 'utf8' })
      expect(blobId(bytes, 'sha1')).toBe(expected.trim())
    }
  })

  it('says each reason in words of its own', () => {
    // Written beside the unions so a value and its words land together; the
    // report (1.4) prints them.
    const sentences = [...BY_DESIGN.map(byDesignReason), ...NOT_ANALYSED.map(notAnalysedReason)]
    for (const sentence of sentences) expect(sentence).toMatch(/^\S.{8,}[^.]$/)
    expect(new Set(sentences).size).toBe(sentences.length)
    expect(notAnalysedReason('link')).toContain('a file with a second name')
    // A sparse checkout leaves tracked paths out of the working tree, and
    // deletes nothing: the words claim only what the walk saw.
    expect(notAnalysedReason('deleted')).toBe('tracked, not in the working tree: deleted, or not checked out')
  })
})
