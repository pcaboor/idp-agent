import { describe, expect, it } from 'vitest'
import { HELP, parseArguments, usageOf } from '../../src/cli/index.js'

describe('parseArguments', () => {
  it('reads the graph command with its filters', () => {
    expect(parseArguments(['graph', '--env', 'prod'])).toEqual({
      name: 'graph',
      options: { env: 'prod' },
    })
  })

  it('reads the show command with its argument', () => {
    expect(parseArguments(['show', 'billing-db-dev'])).toEqual({
      name: 'show',
      query: 'billing-db-dev',
    })
  })

  it('asks for help when given nothing', () => {
    expect(parseArguments([])).toEqual({ name: 'help' })
  })

  it('reads an unknown first word as a phrase, and a near miss of a command as a typo', () => {
    // The phrase goes to the Supervisor (`entry.test.ts`); a word one slip
    // away from a command name never does.
    expect(parseArguments(['destroy'])).toStrictEqual({ name: 'entry', phrase: 'destroy', json: false })
    expect(parseArguments(['grpah']).name).toBe('error')
  })

  it('reports show without an argument', () => {
    expect(parseArguments(['show']).name).toBe('error')
  })

  it('reports an unknown flag rather than ignoring it', () => {
    expect(parseArguments(['graph', '--wat', 'x']).name).toBe('error')
  })

  it('reports an invalid kind', () => {
    expect(parseArguments(['graph', '--kind', 'Banana']).name).toBe('error')
  })

  it('reads plan without --repo: whether one is configured is decided in main, not here', () => {
    expect(parseArguments(['plan', '--from', 'plan.json'])).toStrictEqual({
      name: 'plan',
      source: { from: 'plan.json' },
      json: false,
    })
  })

  it('refuses ask with --repo and no question, rather than asking an empty one', () => {
    expect(parseArguments(['ask', '--repo', 'iac']).name).toBe('error')
  })
})

describe('parseArguments: --repo on the read commands', () => {
  // The declarations repository, like `plan --repo`. Omitted rather than
  // undefined when absent, which is what the demo SI is read on.
  it.each([
    [['graph', '--repo', 'iac', '--env', 'prod'], { name: 'graph', options: { env: 'prod' }, repo: 'iac' }],
    [['graph', '--repo=iac'], { name: 'graph', options: {}, repo: 'iac' }],
    [['show', '--repo', 'iac', 'billing-db-prod'], { name: 'show', query: 'billing-db-prod', repo: 'iac' }],
    [['show', 'billing-db-prod', '--repo=iac'], { name: 'show', query: 'billing-db-prod', repo: 'iac' }],
    [
      ['ask', '--repo', 'iac', 'which databases are in prod?'],
      { name: 'ask', intent: 'which databases are in prod?', repo: 'iac' },
    ],
    [['ask', 'which', 'databases?', '--repo=iac'], { name: 'ask', intent: 'which databases?', repo: 'iac' }],
  ])('reads %j', (argv, expected) => {
    expect(parseArguments(argv)).toEqual(expected)
  })

  // Strict: `toEqual` passes over a property whose value is undefined, which is
  // exactly the shape these cases exist to rule out.
  it.each([
    [['ask', 'which databases are in prod?'], { name: 'ask', intent: 'which databases are in prod?' }],
    [['show', 'billing-db-prod'], { name: 'show', query: 'billing-db-prod' }],
    [['graph', '--env', 'prod'], { name: 'graph', options: { env: 'prod' } }],
  ])('leaves repo out when it was not given: %j', (argv, expected) => {
    expect(parseArguments(argv)).toStrictEqual(expected)
  })

  it('refuses an unknown option to ask rather than sending it to the model as words', () => {
    // Before, every argument was the question: `--wat` reached a third party
    // as part of the sentence it was asked.
    const command = parseArguments(['ask', '--wat', 'which databases are in prod?'])
    expect(command.name).toBe('error')
  })

  it('takes everything after -- as the question, options included', () => {
    expect(parseArguments(['ask', '--repo', 'iac', '--', 'what', 'does', '--repo', 'mean?'])).toEqual({
      name: 'ask',
      intent: 'what does --repo mean?',
      repo: 'iac',
    })
  })

  it('refuses show with two names rather than reading the first', () => {
    const command = parseArguments(['show', 'billing-db-prod', 'orders-db-prod'])
    expect(command).toMatchObject({ name: 'error', message: expect.stringContaining('one') })
  })

  it('refuses show with --repo and no name', () => {
    expect(parseArguments(['show', '--repo', 'iac']).name).toBe('error')
  })
})

describe('parseArguments: --demo on the read commands', () => {
  // The demo SI whatever the working directory holds. Omitted when absent,
  // like `repo`, so the strict cases above still hold.
  it.each([
    [['graph', '--demo'], { name: 'graph', options: {}, demo: true }],
    [['show', 'billing-db-prod', '--demo'], { name: 'show', query: 'billing-db-prod', demo: true }],
    [['ask', '--demo', 'which databases?'], { name: 'ask', intent: 'which databases?', demo: true }],
  ])('reads %j', (argv, expected) => {
    expect(parseArguments(argv)).toStrictEqual(expected)
  })

  it.each([
    [['graph', '--demo', '--repo', 'iac']],
    [['show', 'billing-db-prod', '--repo=iac', '--demo']],
    [['ask', '--demo', '--repo', 'iac', 'which databases?']],
  ])('refuses %j: two sources, and no answer to which one won', (argv) => {
    expect(parseArguments(argv)).toMatchObject({
      name: 'error',
      // Its own words: before `--demo` existed, strict parsing refused it as
      // an unknown option, and a message merely naming it would pass on that.
      message: expect.stringContaining('--repo <directory> or --demo, never both'),
    })
  })

  it.each([[['plan', '--demo', 'x', '--repo', 'iac']], [['init', '--demo']]])(
    'is not an option of %j',
    (argv) => {
      expect(parseArguments(argv).name).toBe('error')
    },
  )
})

describe('parseArguments: --submit', () => {
  it('is a flag of plan --from, and absent unless typed', () => {
    expect(parseArguments(['plan', '--from', 'plan.json', '--submit'])).toStrictEqual({
      name: 'plan',
      source: { from: 'plan.json' },
      json: false,
      submit: true,
    })
    expect(parseArguments(['plan', '--from', 'plan.json'])).not.toHaveProperty('submit')
  })

  it('is a flag of plan "<intent>" too, where it is refused before any model is paid', () => {
    expect(parseArguments(['plan', 'give billing-api read access', '--submit'])).toStrictEqual({
      name: 'plan',
      source: { intent: 'give billing-api read access' },
      json: false,
      submit: true,
    })
    expect(parseArguments(['plan', 'give billing-api read access'])).not.toHaveProperty('submit')
  })

  it('is refused on a phrase, pointing at both roads that submit (D8)', () => {
    // The entry reaches the Supervisor before it knows a phrase is a change,
    // and a submission refuses a repository that cannot take it before any
    // model is paid: at stage 5, a change is submitted by plan.
    for (const argv of [
      ['give billing-api read access to orders-db', '--submit'],
      ['give billing-api read access to orders-db', '--submit', '--demo'],
    ]) {
      expect(parseArguments(argv)).toStrictEqual({
        name: 'error',
        message:
          'idpa "<phrase>" does not submit; a change is submitted with plan "<intent>" --submit, ' +
          'or plan --from <plan.json> --submit',
      })
    }
  })

  it('is refused with --demo only because plan knows no --demo: no write meets the demo SI', () => {
    // Not a --submit rule: plan reads a declarations repository and never the
    // demo SI, so the parser refuses the option whatever else is typed.
    for (const argv of [
      ['plan', '--from', 'plan.json', '--submit', '--demo'],
      ['plan', '--from', 'plan.json', '--demo'],
    ]) {
      expect(parseArguments(argv)).toStrictEqual({
        name: 'error',
        message: expect.stringContaining("Unknown option '--demo'"),
      })
    }
  })
})

describe('HELP: --submit', () => {
  it('is in the usage plan prints, and HELP says what it writes and by which route', () => {
    expect(usageOf('plan')).toContain('idp-agent plan --from <plan.json> [--repo <directory>] [--json] [--submit]')
    // The sentence stage 4 said, whatever its case and however it is wrapped.
    expect(HELP.replace(/\s+/g, ' ').toLowerCase()).not.toContain('none of them writes.')
    expect(HELP.replace(/\s+/g, ' ')).toContain('None of them writes, and neither do plan and init without --submit.')
    expect(HELP).toContain('four gates')
    expect(HELP).toContain('the merge authorises')
  })

  it('names --submit on the intent road, and the five gates that road crosses', () => {
    expect(usageOf('plan')).toContain(
      'idp-agent plan "<intent>" [--repo <directory>] [--project <directory>] [--json] [--submit]',
    )
    expect(HELP.replace(/\s+/g, ' ')).toContain('plan "<intent>" --submit crosses five gates, the Reviewer last')
  })
})

describe('parseArguments: init --submit and its configuration', () => {
  it('reads --submit, --iac-repo and a repeated --environment, and omits what was not typed', () => {
    expect(
      parseArguments(['init', '--submit', '--environment', 'dev', '--environment', 'prod', '--iac-repo', 'x']),
    ).toMatchObject({
      name: 'init',
      submit: true,
      flags: { iacRepo: 'x', environments: ['dev', 'prod'] },
    })
    const bare = parseArguments(['init'])
    expect(bare).toMatchObject({ name: 'init' })
    expect(bare).not.toHaveProperty('submit')
    expect(bare).not.toHaveProperty('flags')
    expect(parseArguments(['init', '--iac-repo', 'x'])).toStrictEqual({
      name: 'init',
      answers: {},
      flags: { iacRepo: 'x' },
    })
  })

  it('takes no URL for Backstage: --backstage is no option of init (D9, ADR-0011)', () => {
    expect(parseArguments(['init', '--backstage', 'https://backstage.example/api/catalog'])).toStrictEqual({
      name: 'error',
      message: expect.stringContaining("Unknown option '--backstage'"),
    })
  })

  it('knows no --env: that is graph’s filter, and init’s flag is --environment', () => {
    expect(parseArguments(['init', '--env', 'prod'])).toStrictEqual({
      name: 'error',
      message: expect.stringContaining("Unknown option '--env'"),
    })
  })

  it('refuses a value holding a control, format or bidi character, naming the flag', () => {
    for (const [flag, value] of [
      ['--environment', 'prod\u2066'],
      ['--iac-repo', 'github.com/acme/\u202eiac'],
      ['--environment', 'dev\nprod'],
    ] as const) {
      const refused = parseArguments(['init', flag, value])
      expect(refused).toMatchObject({ name: 'error', message: expect.stringContaining(flag) })
      if (refused.name === 'error') expect(refused.message).not.toMatch(/[\u2066\u202e\n]/)
    }
  })

  it('refuses a locator that carries a credential, naming the flag and never the secret', () => {
    // A clone URL copied from `git remote -v` holds the token in its userinfo,
    // and the file it would land in is committed and pushed (§7.0).
    for (const value of [
      'https://x-access-token:ghp_SECRET123@github.com/acme/iac',
      'https://ghp_SECRET123@github.com/acme/iac',
      'git@github.com:acme/iac.git',
      'github.com/acme/iac?access_token=ghp_SECRET123',
      'github.com/acme/iac#ghp_SECRET123',
    ]) {
      const refused = parseArguments(['init', '--iac-repo', value])
      expect(refused).toMatchObject({ name: 'error', message: expect.stringContaining('--iac-repo') })
      if (refused.name === 'error') {
        expect(refused.message).toContain('userinfo, a query or a fragment')
        expect(refused.message).not.toContain('SECRET')
        expect(refused.message).not.toContain('x-access-token')
      }
    }
    for (const value of ['github.com/acme/iac', 'https://github.com/acme/iac.git', 'acme/iac']) {
      expect(parseArguments(['init', '--iac-repo', value])).toMatchObject({ name: 'init', flags: { iacRepo: value } })
    }
  })

  it('refuses --iac-repo typed twice, rather than keeping the last one in silence', () => {
    const refused = parseArguments(['init', '--iac-repo', 'github.com/acme/a', '--iac-repo', 'github.com/acme/b'])
    expect(refused).toMatchObject({ name: 'error', message: expect.stringContaining('--iac-repo') })
    if (refused.name === 'error') {
      expect(refused.message).toContain('once')
      expect(refused.message).not.toContain('acme/a')
    }
  })

  it('spells out a format character it refuses, so the person can see what to remove', () => {
    // U+200B is no bidi control, and `inertLine` alone would print it raw.
    const refused = parseArguments(['init', '--iac-repo', 'a\u200bb'])
    expect(refused).toMatchObject({ name: 'error', message: expect.stringContaining('a\\u200bb') })
    if (refused.name === 'error') expect(refused.message).not.toContain('\u200b')
  })

  it('refuses a value its field of the configuration schema refuses, naming the flag', () => {
    for (const [flag, value] of [
      ['--iac-repo', ''],
      ['--environment', 'x'.repeat(64)],
    ] as const) {
      expect(parseArguments(['init', flag, value])).toMatchObject({
        name: 'error',
        message: expect.stringContaining(`${flag} does not make a .idp-agent.yml`),
      })
    }
  })

  it('is in the usage init prints', () => {
    expect(usageOf('init')).toContain(
      'idp-agent init [--repo <directory>] [--name <name>] [--lifecycle experimental|production|deprecated] ' +
        '[--owner group:<namespace>/<name>] [--submit] [--iac-repo <locator>] [--environment <name>]...',
    )
  })
})
