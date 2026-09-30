import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { baseOfMerge, isRemoteName, parseRemoteUrl } from '../../src/core/github/remote.js'
import { checkGhArgv, ghArgv, type GhRoute } from '../../src/process/gh.js'
import { GITHUB_PUSH_URL, HARDENING, checkGitArgv } from '../../src/process/git.js'

/**
 * Two copies of the grammars, one answer (stage 6 plan, "Choices"). `process/`
 * imports nothing of ours, so the launchers hold their own copies of what
 * `core/github/remote.ts` judges with: a remote's name, a base, a push URL,
 * an owner and a name. The engine decides with one copy and the launcher
 * refuses with the other, so a character the two disagree about is either a
 * road the engine chose and the launcher then refuses, or a value the
 * launcher would run that the engine never meant to hand it.
 *
 * Each pair is read through the launchers' public checks, the vector built as
 * the forge builds it, so `process/` exports nothing for this test. The
 * inputs are fast-check strings over an alphabet weighted towards the
 * characters each grammar is about, and the cases the stage 6 note names.
 */

/** A launcher's check, as a verdict. */
const passes = (check: () => void): boolean => {
  try {
    check()
    return true
  } catch {
    return false
  }
}

/** The characters the grammars are about, and a few that are plain, weighted towards the plain. */
const unit = fc.oneof(
  { weight: 12, arbitrary: fc.constantFrom('a', 'b', 'c', 'k', 'l', 'o', 'Z', '0', '9') },
  { weight: 4, arbitrary: fc.constantFrom('-', '.', '/', '_') },
  { weight: 1, arbitrary: fc.constantFrom('%', '{', '}', '@', ':', ' ', '~', '^', '?', '*', '[', '\\', '\u0007', '\u007F') },
  { weight: 1, arbitrary: fc.constantFrom('\u202E', '\u2066', '\u200B', 'é') },
)
const word = (maxLength: number): fc.Arbitrary<string> => fc.string({ unit, minLength: 0, maxLength })
/** Near a length bound, where an off-by-one lives. */
const long = (from: number, to: number): fc.Arbitrary<string> =>
  fc.tuple(fc.integer({ min: from, max: to }), fc.constantFrom('a', '-', '.', '_')).map(([length, tail]) => `${'r'.repeat(length - 1)}${tail}`)

const RUNS = { numRuns: 2_000 }

const gitPasses = (...args: string[]): boolean => passes(() => checkGitArgv([...HARDENING, '-C', '/r', ...args]))
const ghPasses = (route: GhRoute): boolean => passes(() => checkGhArgv(ghArgv({ kind: 'get', route })))

/** The five forms and their near misses, for the push URL's property. */
const PREFIXES = [
  'https://github.com/',
  'git@github.com:',
  'ssh://git@github.com/',
  'ssh://git@ssh.github.com:443/',
  'org-4711@github.com:',
  'http://github.com/',
  'https://GitHub.com/',
  'ssh://git@ssh.github.com/',
  'git@gitlab.example.com:',
  'org-@github.com:',
  'x@github.com:',
]

describe('the two copies of each grammar give one answer', () => {
  it("a remote's name: git's check iff isRemoteName", () => {
    const named = ['origin', 'up/stream', 'a.b_c-d', '--push', '.hidden', '-x', 'a b', '', 'r'.repeat(100), 'r'.repeat(101)]
    for (const name of named) {
      expect(gitPasses('remote', 'get-url', '--all', '--', name), JSON.stringify(name)).toBe(isRemoteName(name))
    }
    fc.assert(
      fc.property(fc.oneof(word(24), long(98, 102)), (name) => {
        expect(gitPasses('remote', 'get-url', '--all', '--', name)).toBe(isRemoteName(name))
        expect(gitPasses('remote', 'get-url', '--push', '--all', '--', name)).toBe(isRemoteName(name))
      }),
      RUNS,
    )
  })

  it("a base: git's check and gh's rules path iff baseOfMerge", () => {
    const named = [
      'main',
      'release/1',
      '-x',
      'a..b',
      'a{b',
      'a%b',
      'x.lock',
      'x.lock/y',
      'x/',
      'x.',
      '@',
      'a@{b',
      'a//b',
      'a/.b',
      'ma\u202Ein',
      'ma\u200Bin',
      'b'.repeat(255),
      'b'.repeat(256),
      'é'.repeat(127),
      'é'.repeat(128),
    ]
    const agree = (base: string): void => {
      const engine = baseOfMerge(`refs/heads/${base}`) === base
      expect(gitPasses('check-ref-format', '--branch', base), JSON.stringify(base)).toBe(engine)
      expect(ghPasses({ route: 'rules', owner: 'acme', name: 'iac', branch: base }), JSON.stringify(base)).toBe(engine)
    }
    for (const base of named) agree(base)
    fc.assert(fc.property(fc.oneof(word(24), long(253, 257)), agree), RUNS)
  })

  it("a push URL: the push's grammar iff parseRemoteUrl reads GitHub's", () => {
    const named = [
      'git@github.com:acme/iac.git',
      'https://github.com/acme/iac',
      'ssh://git@ssh.github.com:443/acme/iac.git',
      'org-4711@github.com:acme/iac',
      'https://x-access-token:canary@github.com/acme/iac.git',
      'https://github.com/acme/iac/',
      'https://github.com/acme/.',
      'https://github.com/acme/..git',
      'https://github.com/acme/.git',
      `https://github.com/acme/${'r'.repeat(100)}.git`,
      `https://github.com/acme/${'r'.repeat(101)}`,
      '-uhttps://github.com/acme/iac',
    ]
    const agree = (url: string): void => {
      expect(GITHUB_PUSH_URL.test(url), JSON.stringify(url)).toBe(parseRemoteUrl(url).kind === 'github')
    }
    for (const url of named) agree(url)
    fc.assert(
      fc.property(
        fc.constantFrom(...PREFIXES),
        fc.oneof(word(12), fc.constantFrom('acme', '-acme', 'o'.repeat(39), 'o'.repeat(40))),
        fc.oneof(word(12), long(98, 102), fc.constantFrom('.', '..', '', 'iac')),
        fc.constantFrom('', '.git', '/', '.git/'),
        (prefix, owner, name, suffix) => agree(`${prefix}${owner}/${name}${suffix}`),
      ),
      RUNS,
    )
  })

  it("an owner and a name: gh's repository path iff parseRemoteUrl reads exactly them", () => {
    const agree = (owner: string, name: string): void => {
      const read = parseRemoteUrl(`git@github.com:${owner}/${name}.git`)
      const engine = read.kind === 'github' && read.repository.owner === owner && read.repository.name === name
      expect(ghPasses({ route: 'repository', owner, name }), JSON.stringify([owner, name])).toBe(engine)
    }
    for (const [owner, name] of [
      ['acme', 'iac'],
      ['-acme', 'iac'],
      ['acme', '.'],
      ['acme', '..'],
      ['acme', ''],
      ['acme', '.git'],
      ['acme', 'x.git'],
      ['o'.repeat(39), 'r'.repeat(100)],
      ['o'.repeat(40), 'iac'],
      ['acme', 'r'.repeat(101)],
    ] as const) {
      agree(owner, name)
    }
    fc.assert(
      fc.property(
        fc.oneof(word(12), fc.constantFrom('acme', 'o'.repeat(39), 'o'.repeat(40))),
        fc.oneof(word(12), long(98, 102)),
        agree,
      ),
      RUNS,
    )
  })
})
