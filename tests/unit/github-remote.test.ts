import { describe, expect, it } from 'vitest'
import {
  baseOfMerge,
  isLogin,
  isRemoteName,
  parseRemoteUrl,
  printedRepository,
  sameRepository,
  type GitHubRepository,
} from '../../src/core/github/remote.js'

/**
 * The remote a submission would push to, read from the URL the person's own
 * git prints (stage 6 brief § 13): one of GitHub's five forms, another host,
 * a URL that carries a credential, or a GitHub URL that does not parse. And
 * the grammars a value read from a hostile `.git/config` is held to before it
 * reaches a process or a sentence. Pure: no process, no disk.
 *
 * NO REAL TOKEN IS WRITTEN HERE: the canaries were never issued by anyone.
 */

const ACME: GitHubRepository = { host: 'github.com', owner: 'acme', name: 'iac' }

describe('parseRemoteUrl', () => {
  it('parses the five forms, with and without .git', () => {
    for (const form of [
      'https://github.com/acme/iac',
      'git@github.com:acme/iac',
      'ssh://git@github.com/acme/iac',
      'ssh://git@ssh.github.com:443/acme/iac',
      'org-4711@github.com:acme/iac',
    ]) {
      for (const url of [form, `${form}.git`]) {
        expect(parseRemoteUrl(url), url).toEqual({ kind: 'github', repository: ACME, url })
      }
    }
  })

  it('keeps the owner and the name as written, and the name of a repository holding dots', () => {
    expect(parseRemoteUrl('git@github.com:Acme-Corp/my.iac_v2.git')).toEqual({
      kind: 'github',
      repository: { host: 'github.com', owner: 'Acme-Corp', name: 'my.iac_v2' },
      url: 'git@github.com:Acme-Corp/my.iac_v2.git',
    })
  })

  it('reads a name of 100 characters, with .git or without', () => {
    const name = 'r'.repeat(100)
    for (const url of [`git@github.com:acme/${name}`, `git@github.com:acme/${name}.git`]) {
      expect(parseRemoteUrl(url), url).toMatchObject({ kind: 'github', repository: { name } })
    }
  })

  it('refuses userinfo, and reads its host and path so the refusal can name them', () => {
    expect(parseRemoteUrl('https://x-access-token:canary@github.com/acme/iac.git')).toEqual({
      kind: 'userinfo',
      host: 'github.com',
      path: 'acme/iac.git',
    })
    for (const url of ['https://ada@github.com/acme/iac', 'ssh://ada@github.com/acme/iac', 'ada@github.com:acme/iac']) {
      expect(parseRemoteUrl(url), url).toEqual({ kind: 'userinfo', host: 'github.com', path: 'acme/iac' })
    }
  })

  it('sends every other host down the stage-5 road', () => {
    expect(parseRemoteUrl('git@gitlab.example.com:acme/iac.git')).toEqual({ kind: 'other-host', host: 'gitlab.example.com' })
    expect(parseRemoteUrl('https://gitlab.example.com/acme/iac')).toEqual({ kind: 'other-host', host: 'gitlab.example.com' })
    expect(parseRemoteUrl('ssh://git@git.acme.internal:2222/iac')).toEqual({ kind: 'other-host', host: 'git.acme.internal' })
    // A token on another host is not idpa's to judge: nothing is pushed there,
    // and the host alone is named.
    expect(parseRemoteUrl('https://oauth2:canary@gitlab.example.com/acme/iac.git')).toEqual({
      kind: 'other-host',
      host: 'gitlab.example.com',
    })
    for (const local of ['/srv/iac.git', '../iac', 'file:///srv/iac.git', 'iac']) {
      expect(parseRemoteUrl(local), local).toEqual({ kind: 'other-host', host: 'this machine' })
    }
  })

  it('names no host it cannot read as one', () => {
    expect(parseRemoteUrl('https://[::1]:8443/acme/iac')).toEqual({ kind: 'other-host', host: 'a host this build does not name' })
  })

  it('refuses a GitHub URL that does not parse', () => {
    const unreadable = [
      'https://github.com/acme',
      'https://github.com/acme/iac/',
      'https://github.com/acme/iac/tree/main',
      'http://github.com/acme/iac',
      'git://github.com/acme/iac',
      'github.com:acme/iac',
      'ssh://git@github.com:22/acme/iac',
      'ssh://git@ssh.github.com/acme/iac',
      // Hosts are matched as GitHub prints them.
      'https://GitHub.com/acme/iac',
      'git@GITHUB.COM:acme/iac',
      'https://github.com/-acme/iac',
      'https://github.com/acme/.',
      'https://github.com/acme/..',
      'https://github.com/acme/..git',
      'https://github.com/acme/.git',
      `https://github.com/acme/${'r'.repeat(101)}`,
      `https://github.com/${'o'.repeat(40)}/iac`,
      'https://github.com/acme/iac?tab=readme',
      'https://github.com/acme/iac#readme',
      'https://github.com:443/acme/iac',
      'ssh://org-4711@github.com/acme/iac',
    ]
    for (const url of unreadable) expect(parseRemoteUrl(url), url).toEqual({ kind: 'unreadable' })
  })

  it('refuses a control or bidi character anywhere', () => {
    for (const hidden of ['\u202E', '\u2066', '\u200B', '\u0007', '\n', '\u007F']) {
      for (const url of [
        `git@github.com:acme/ia${hidden}c.git`,
        `git@github.com:ac${hidden}me/iac.git`,
        `https://github.com${hidden}/acme/iac`,
        `git@gitlab.example.com:acme/iac${hidden}.git`,
      ]) {
        expect(parseRemoteUrl(url), JSON.stringify(url)).toEqual({ kind: 'unreadable' })
      }
    }
  })
})

describe('the grammars a hostile configuration is held to', () => {
  it("holds a remote's name to its grammar", () => {
    for (const name of ['origin', 'up/stream', 'a.b_c-d', 'r'.repeat(100)]) expect(isRemoteName(name), name).toBe(true)
    for (const name of ['--push', '.hidden', '-x', 'r'.repeat(101), 'a b', '', 'a:b', 'ori\u202Egin']) {
      expect(isRemoteName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it('reads a base from branch.<name>.merge, and only a branch', () => {
    expect(baseOfMerge('refs/heads/main')).toBe('main')
    expect(baseOfMerge('refs/heads/release/1')).toBe('release/1')
    for (const merge of [
      'refs/tags/v1',
      'refs/pull/1/head',
      'main',
      'refs/heads/',
      'refs/heads/-x',
      'refs/heads/a..b',
      'refs/heads/a{b',
      'refs/heads/a}b',
      'refs/heads/a%b',
      'refs/heads/a:b',
      'refs/heads/a b',
      'refs/heads/x.lock',
      'refs/heads/x/',
      'refs/heads/@',
      'refs/heads/ma\u202Ein',
      'refs/heads/ma\u200Bin',
      `refs/heads/${'b'.repeat(256)}`,
    ]) {
      expect(baseOfMerge(merge), JSON.stringify(merge)).toBeUndefined()
    }
    expect(baseOfMerge(`refs/heads/${'b'.repeat(255)}`)).toBe('b'.repeat(255))
  })

  it('holds a login to GitHub’s grammar, a bot’s suffix included', () => {
    for (const login of ['ada', 'Ada-L', 'github-actions[bot]', 'a'.repeat(39)]) expect(isLogin(login), login).toBe(true)
    for (const login of ['-ada', 'ada b', 'a/b', 'a'.repeat(40), '', 'ada[bot', 'a\u202Eda']) {
      expect(isLogin(login), JSON.stringify(login)).toBe(false)
    }
  })

  it('compares repositories as GitHub does, ignoring case', () => {
    expect(sameRepository(ACME, { host: 'github.com', owner: 'ACME', name: 'IaC' })).toBe(true)
    expect(sameRepository(ACME, { host: 'github.com', owner: 'evil', name: 'iac' })).toBe(false)
    expect(sameRepository(ACME, { host: 'github.com', owner: 'acme', name: 'iac2' })).toBe(false)
  })

  it('prints a repository as github.com/<owner>/<name>', () => {
    expect(printedRepository(ACME)).toBe('github.com/acme/iac')
  })
})
