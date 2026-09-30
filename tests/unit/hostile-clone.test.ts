import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KEPT_LOCAL_KEYS, REFUSED_KEYS } from '../../src/core/github/config.js'
import { ForgeInputError } from '../../src/forge/errors.js'
import { openGitHub } from '../../src/forge/github/open.js'
import { clearedFor, removeClones, scratch } from '../support/forge-fixture.js'
import { fakeSsh, githubClone, githubForge, remoteRefs, type GitHubClone } from '../support/github-fixture.js'
import { git, observable } from '../support/git.js'

/**
 * A hostile repository (stage 6 brief § 7): the clone's own configuration is
 * whoever wrote it, and a key that would decide where the push goes, who
 * authenticates it or what runs during it is refused — named, with its scope,
 * never with its value — before anything is written, and again at the moment
 * of acting. The person's global configuration is theirs, and is honoured.
 * The value is always the canary, so a sentence that quotes one is caught.
 */

afterAll(removeClones)

const CANARY = 'hostile-value-0123'

/** One key of each refused section, each refused key, and a remote's five. */
const REFUSED = [
  'url.https://example.com/.insteadOf',
  'credential.helper',
  'http.proxy',
  'protocol.allow',
  'ssh.variant',
  'gpg.program',
  'push.pushOption',
  ...REFUSED_KEYS,
  'remote.origin.vcs',
  'remote.origin.receivepack',
  'remote.origin.uploadpack',
  'remote.origin.proxy',
  'remote.origin.proxyAuthMethod',
]

/** What `openGitHub` threw, which must be the person's to fix: exit 2. */
const refusal = async (clone: GitHubClone): Promise<ForgeInputError> => {
  const error: unknown = await openGitHub({ repo: clone.repo, env: clone.env, gh: clone.gh.process, local: false }).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(ForgeInputError)
  return error as ForgeInputError
}

describe('a hostile clone', () => {
  it.each(REFUSED)("refuses %s set in the clone's own configuration, naming it and never its value", async (key) => {
    const clone = await githubClone()
    const refs = await remoteRefs(clone.bare)
    await git(clone.repo, 'config', '--local', key, CANARY)

    const error = await refusal(clone)

    // git lists a section and a variable in lower case, and so names them.
    expect(error.message).toContain(`${key.toLowerCase()} (local)`)
    expect(error.message).not.toContain(CANARY)
    expect(await remoteRefs(clone.bare)).toBe(refs)
  })

  it('refuses the same key hidden behind include.path', async () => {
    const clone = await githubClone()
    const included = path.join(await scratch('idp-included-'), 'config')
    await writeFile(included, `[credential]\n\thelper = ${CANARY}\n`)
    await git(clone.repo, 'config', '--local', 'include.path', included)

    const error = await refusal(clone)

    expect(error.message).toContain('credential.helper (local)')
    expect(error.message).not.toContain(CANARY)
  })

  it("never prints a credential a key's subsection holds", async () => {
    for (const key of [
      `url.https://x-access-token:${CANARY}@github.com/.insteadOf`,
      `http.https://example.com/?access_token=${CANARY}.extraHeader`,
    ]) {
      const clone = await githubClone()
      await git(clone.repo, 'config', '--local', key, 'nothing-this-build-reads')

      const error = await refusal(clone)

      expect(error.message, key).toContain('<a URL this build does not print>')
      expect(error.message, key).toContain('git config --local --edit')
      expect(error.message, key).not.toContain(CANARY)
    }
  })

  it('refuses a key set in the clone after the confirmation', async () => {
    const clone = await githubClone()
    const change = await clearedFor(clone.repo)
    const { forge } = await githubForge(clone)
    const base = await forge.base()
    expect(await forge.recognise(change, base)).toBeUndefined()
    await git(clone.repo, 'config', '--local', 'url.https://example.com/.insteadOf', CANARY)
    const before = [await observable(clone.repo), await remoteRefs(clone.bare)]

    const result = await forge.submit(change, base)

    expect(result).toMatchObject({ outcome: 'refused' })
    expect(result).not.toHaveProperty('kept')
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect([await observable(clone.repo), await remoteRefs(clone.bare)]).toEqual(before)
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it('leaves the six local keys a person keeps', async () => {
    const clone = await githubClone()
    const values: Record<string, string> = {
      'http.postbuffer': '524288000',
      'http.lowspeedlimit': '1000',
      'http.lowspeedtime': '60',
      'push.default': 'simple',
      'push.autosetupremote': 'true',
      'gpg.format': 'ssh',
    }
    expect(Object.keys(values).sort()).toEqual([...KEPT_LOCAL_KEYS].sort())
    for (const [key, value] of Object.entries(values)) await git(clone.repo, 'config', '--local', key, value)
    const change = await clearedFor(clone.repo)
    const { forge } = await githubForge(clone)

    expect(await forge.submit(change, await forge.base())).toMatchObject({ outcome: 'created', pushed: true })
  })

  it("honours the person's global configuration where the clone's is refused", async () => {
    // Each refused key, set where the person keeps their own, with a value
    // under which an ssh push to the bare repository still works; and the ssh
    // itself named there, with no variable to outrank it, carries the push.
    const clone = await githubClone()
    delete clone.env['GIT_SSH_COMMAND']
    const ssh = await fakeSsh(path.dirname(clone.bare), clone.bare)
    await writeFile(
      path.join(clone.env['HOME'] ?? '', '.gitconfig'),
      [
        '[url "https://example.com/"]',
        `\tinsteadOf = ${CANARY}`,
        '[credential]',
        '\thelper = "!f() { :; }; f"',
        '[http]',
        '\tproxy = http://127.0.0.1:9',
        '[protocol]',
        '\tallow = always',
        '[ssh]',
        '\tvariant = simple',
        '[gpg]',
        '\tprogram = false',
        '[push]',
        '\tnegotiate = false',
        '[core]',
        `\tsshCommand = ${ssh}`,
        '\taskPass = false',
        '\tgitProxy = false',
        '[remote "origin"]',
        '\treceivepack = git-receive-pack',
        '\tuploadpack = git-upload-pack',
        '\tproxy = http://127.0.0.1:9',
        '\tproxyAuthMethod = basic',
        '',
      ].join('\n'),
    )
    const change = await clearedFor(clone.repo)
    const { forge } = await githubForge(clone)

    expect(await forge.submit(change, await forge.base())).toMatchObject({ outcome: 'created', pushed: true })
    expect(await git(clone.bare, 'rev-parse', `refs/heads/${change.branch}`)).toBe(
      await git(clone.repo, 'rev-parse', `refs/heads/${change.branch}`),
    )
  })
})
