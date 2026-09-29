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

  it('is refused on plan "<intent>" until that road submits, rather than dropped', () => {
    // Removed by the next change, which teaches the intent road to submit.
    expect(parseArguments(['plan', 'give billing-api read access', '--submit'])).toStrictEqual({
      name: 'error',
      message: 'plan "<intent>" --submit is not wired yet; use --from <plan.json> --submit',
    })
  })

  it('is refused on a phrase, pointing at the one road that submits today (D8)', () => {
    // Only plan --from: plan "<intent>" --submit is refused too until the next
    // change, and a refusal that points at another refusal is a dead end.
    for (const argv of [
      ['give billing-api read access to orders-db', '--submit'],
      ['give billing-api read access to orders-db', '--submit', '--demo'],
    ]) {
      expect(parseArguments(argv)).toStrictEqual({
        name: 'error',
        message: 'idpa "<phrase>" does not submit; a change is submitted with plan --from <plan.json> --submit',
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
    expect(HELP.replace(/\s+/g, ' ')).toContain('None of them writes, and neither does plan without --submit.')
    expect(HELP).toContain('four gates')
    expect(HELP).toContain('the merge authorises')
  })
})
