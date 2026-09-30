import { describe, expect, it } from 'vitest'
import {
  KEPT_LOCAL_KEYS,
  REFUSED_KEYS,
  REFUSED_SECTIONS,
  configRefusal,
  parseConfigListing,
  refusedConfigKeys,
  type ConfigEntry,
} from '../../src/core/github/config.js'
import { inertLine } from '../../src/cli/render/plain.js'

/**
 * A clone's own configuration is hostile (stage 6 brief § 7): a key at the
 * `local` or `worktree` scope that could redirect the push, choose who
 * authenticates it or run a program during it is refused, by key and scope,
 * and never by value. The person's global and system configuration is
 * theirs. Pure: the listing is the bytes `git config --list --show-scope -z`
 * prints, measured on git 2.46; `road.test.ts` reads real clones.
 *
 * NO REAL TOKEN IS WRITTEN HERE: the canaries were never issued by anyone.
 */

const at = (scope: string, key: string): ConfigEntry => ({ scope, key })

const SECTION_KEYS = [
  'url.git@evil.example:.insteadof',
  'credential.helper',
  'credential.https://github.com.helper',
  'http.proxy',
  'http.https://github.com/.extraheader',
  'protocol.allow',
  'ssh.variant',
  'gpg.program',
  'push.pushoption',
]

describe('parseConfigListing', () => {
  it("reads git's listing and keeps no value", () => {
    const bytes = Buffer.from(
      'local\0core.bare\nfalse\0' +
        'local\0core.ignorecase\0' +
        'command\0core.hookspath\n/dev/null\0' +
        'local\0credential.helper\nstore --file=/tmp/canary\nsecond=line\0' +
        'worktree\0http.https://github.com/.extraheader\nAUTHORIZATION: basic canary\0',
      'utf8',
    )
    const entries = parseConfigListing(bytes)
    expect(entries).toEqual([
      at('local', 'core.bare'),
      at('local', 'core.ignorecase'),
      at('command', 'core.hookspath'),
      at('local', 'credential.helper'),
      at('worktree', 'http.https://github.com/.extraheader'),
    ])
    const written = JSON.stringify(entries)
    for (const value of ['false', '/dev/null', 'canary', 'second=line', 'store']) expect(written).not.toContain(value)
  })

  it('reads an empty listing as no key', () => {
    expect(parseConfigListing(Buffer.alloc(0))).toEqual([])
  })

  it('refuses a listing it cannot pair', () => {
    expect(() => parseConfigListing(Buffer.from('local\0core.bare\nfalse\0local\0', 'utf8'))).toThrow()
    expect(() => parseConfigListing(Buffer.from('local\0core.bare\nfalse', 'utf8'))).toThrow()
  })
})

describe('refusedConfigKeys', () => {
  it('refuses the seven sections at the local and worktree scopes, and only there', () => {
    expect([...REFUSED_SECTIONS].sort()).toEqual(['credential', 'gpg', 'http', 'protocol', 'push', 'ssh', 'url'])
    for (const key of SECTION_KEYS) {
      for (const scope of ['local', 'worktree']) {
        expect(refusedConfigKeys([at(scope, key)]), `${key} (${scope})`).toEqual([at(scope, key)])
      }
      for (const scope of ['global', 'system', 'command']) {
        expect(refusedConfigKeys([at(scope, key)]), `${key} (${scope})`).toEqual([])
      }
    }
  })

  it('refuses the named keys, for any remote', () => {
    expect([...REFUSED_KEYS].sort()).toEqual(['core.askpass', 'core.gitproxy', 'core.sshcommand'])
    for (const key of [
      'core.sshcommand',
      'core.askpass',
      'core.gitproxy',
      'remote.origin.vcs',
      'remote.origin.receivepack',
      'remote.origin.uploadpack',
      'remote.origin.proxy',
      'remote.origin.proxyauthmethod',
      'remote.up/stream.receivepack',
      'remote.git@evil.example:x.uploadpack',
    ]) {
      expect(refusedConfigKeys([at('local', key)]), key).toEqual([at('local', key)])
    }
  })

  it("refuses a remote section named after a URL: git looks a push's URL up as a remote's name first", () => {
    // Measured, git 2.46: `git push git@github.com:acme/iac.git …` in a clone
    // whose .git/config holds [remote "git@github.com:acme/iac.git"] url = <path>
    // pushes to <path>, whose pre-receive hook then runs. Every push form
    // holds ':', which no remote's name does.
    for (const key of [
      'remote.git@github.com:acme/iac.git.url',
      'remote.git@github.com:acme/iac.git.pushurl',
      'remote.https://github.com/acme/iac.url',
      'remote.ssh://git@ssh.github.com:443/acme/iac.pushurl',
      'remote.org-4711@github.com:acme/iac.git.fetch',
      'remote.-x.url',
      'remote..hidden.pushurl',
    ]) {
      for (const scope of ['local', 'worktree']) {
        expect(refusedConfigKeys([at(scope, key)]), `${key} (${scope})`).toEqual([at(scope, key)])
      }
      for (const scope of ['global', 'system', 'command']) {
        expect(refusedConfigKeys([at(scope, key)]), `${key} (${scope})`).toEqual([])
      }
    }
  })

  it("reads a named remote's URLs rather than refusing them: `readRoad` reads and checks them", () => {
    for (const key of [
      'remote.origin.url',
      'remote.origin.pushurl',
      'remote.up/stream.url',
      'remote.origin.fetch',
      'remote.origin.mirror',
      'core.bare',
      'core.hookspath',
      'user.email',
      'include.path',
      'branch.main.remote',
    ]) {
      expect(refusedConfigKeys([at('local', key)]), key).toEqual([])
    }
  })

  it('keeps the six harmless two-part keys, and only without a subsection', () => {
    expect([...KEPT_LOCAL_KEYS].sort()).toEqual([
      'gpg.format',
      'http.lowspeedlimit',
      'http.lowspeedtime',
      'http.postbuffer',
      'push.autosetupremote',
      'push.default',
    ])
    for (const key of KEPT_LOCAL_KEYS) expect(refusedConfigKeys([at('local', key)]), key).toEqual([])
    // Written by hand, a key keeps its case; git compares section and name without it.
    expect(refusedConfigKeys([at('local', 'HTTP.PostBuffer')])).toEqual([])
    expect(refusedConfigKeys([at('local', 'Credential.Helper')])).toEqual([at('local', 'Credential.Helper')])
    expect(refusedConfigKeys([at('local', 'Core.SSHCommand')])).toEqual([at('local', 'Core.SSHCommand')])
    expect(refusedConfigKeys([at('local', 'http.https://x.postbuffer')])).toEqual([at('local', 'http.https://x.postbuffer')])
  })

  it('keeps the order of the listing', () => {
    const entries = [at('local', 'push.pushoption'), at('global', 'credential.helper'), at('worktree', 'ssh.variant')]
    expect(refusedConfigKeys(entries)).toEqual([at('local', 'push.pushoption'), at('worktree', 'ssh.variant')])
  })
})

describe('configRefusal', () => {
  it('says which key, where, and what it would decide, never its value', () => {
    expect(configRefusal(at('local', 'credential.helper'), 0)).toBe(
      "this clone's own configuration sets credential.helper (local), which would decide who pushes for you; " +
        'idpa pushes only with your global git configuration. Remove it with ' +
        '`git config --local --unset-all credential.helper`, or set it globally, then run this again. ' +
        'Nothing was written.',
    )
    for (const key of [
      'url.git@evil.example:.insteadof',
      'remote.origin.proxy',
      'remote.origin.proxyauthmethod',
      'remote.git@github.com:acme/iac.git.url',
      'remote.https://github.com/acme/iac.pushurl',
      'http.proxy',
      'protocol.allow',
    ]) {
      expect(configRefusal(at('local', key), 0), key).toContain(', which would decide where your push goes;')
    }
    for (const key of [
      'core.sshcommand',
      'gpg.program',
      'push.pushoption',
      'ssh.variant',
      'remote.origin.vcs',
      'remote.origin.receivepack',
      'remote.origin.uploadpack',
      'remote.git@github.com:acme/iac.git.receivepack',
    ]) {
      expect(configRefusal(at('worktree', key), 0), key).toContain(', which would decide what program runs during your push;')
    }
    expect(configRefusal(at('worktree', 'core.sshcommand'), 0)).toContain(
      'core.sshcommand (worktree), which would decide what program runs during your push; ' +
        'idpa pushes only with your global git configuration. Remove it with ' +
        '`git config --worktree --unset-all core.sshcommand`',
    )
  })

  it('prints a subsection only when it has a shape that cannot carry a credential', () => {
    for (const key of [
      'http.https://github.com/.extraheader',
      'http.https://github.com.extraheader',
      'remote.origin.vcs',
      'credential.https://github.com.helper',
    ]) {
      const sentence = configRefusal(at('local', key), 0)
      expect(sentence, key).toContain(` ${key} (local)`)
      expect(sentence, key).toContain(`\`git config --local --unset-all ${key}\``)
    }
    const hostile: readonly [string, string][] = [
      ['url.https://x-access-token:canary@github.com/.insteadof', 'url.<a URL this build does not print>.insteadof'],
      ['http.https://example.com/?access_token=canary.extraheader', 'http.<a URL this build does not print>.extraheader'],
      ['http.https://example.com/#canary.extraheader', 'http.<a URL this build does not print>.extraheader'],
      ['http.https://example.com/%40canary.extraheader', 'http.<a URL this build does not print>.extraheader'],
      ['credential.https://example.com/;canary.helper', 'credential.<a URL this build does not print>.helper'],
      ['url.git@evil.example:.insteadof', 'url.<a URL this build does not print>.insteadof'],
      ['url.https://github.com/\u202Ecanary.insteadof', 'url.<a URL this build does not print>.insteadof'],
      // A path can carry a secret too, as a webhook's does: a URL is printed with none.
      ['http.https://example.com/hooks/T000/B000/canary/.extraheader', 'http.<a URL this build does not print>.extraheader'],
      ['url.https://github.com/acme/canary.insteadof', 'url.<a URL this build does not print>.insteadof'],
      ['remote.git@github.com:acme/canary.git.url', 'remote.<a name this build does not print>.url'],
      ['remote.canary token.proxy', 'remote.<a name this build does not print>.proxy'],
      ['remote.git@evil.example:canary.uploadpack', 'remote.<a name this build does not print>.uploadpack'],
    ]
    for (const [key, named] of hostile) {
      const sentence = configRefusal(at('local', key), 0)
      expect(sentence, key).not.toContain('canary')
      expect(sentence, key).not.toContain('\u202E')
      expect(sentence, key).toContain(`sets ${named} (local)`)
      expect(sentence, key).toContain('Remove it with `git config --local --edit`, or set it globally')
    }
  })

  it('prints nothing a terminal would read differently', () => {
    for (const key of [...SECTION_KEYS, 'remote.origin.vcs', 'url.https://github.com/\u202Ecanary.insteadof', 'ht\u202Etp.proxy']) {
      const sentence = configRefusal(at('local', key), 0)
      expect(inertLine(sentence), key).toBe(sentence)
    }
    expect(configRefusal(at('local', 'ht\u202Etp.proxy'), 0)).toContain('sets <a key this build does not print> (local)')
  })

  it('says how many more keys of this kind the clone sets', () => {
    expect(configRefusal(at('local', 'credential.helper'), 2)).toMatch(
      / then run this again\. It sets 2 more keys of this kind; each is refused the same way\. Nothing was written\.$/,
    )
    expect(configRefusal(at('local', 'credential.helper'), 1)).toContain(
      'It sets 1 more key of this kind; each is refused the same way. Nothing was written.',
    )
  })
})
