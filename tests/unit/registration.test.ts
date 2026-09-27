import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse, parseAllDocuments } from 'yaml'
import {
  REGISTRATION_FILE,
  registers,
  registrationName,
  registrationTargets,
  COMPONENT_FOLDER,
  registrationsIn,
  renderRegistration,
} from '../../src/core/validate/registration.js'
import {
  checkRepository,
  repositoryFileOf,
  type RepositorySnapshot,
} from '../../src/core/validate/rules.js'
import { RESOURCE_TYPE_NAMES, folderOf } from '../../src/core/schemas/resource-types.js'

const FOLDERS = [...new Set(RESOURCE_TYPE_NAMES.map(folderOf))].sort()
const ROOTS = [...new Set(FOLDERS.map((folder) => folder.split('/')[0] ?? ''))].sort()

/** A repository `init platform` laid out, with this text as its root catalog-info.yaml. */
const scaffolded = (registration: string): RepositorySnapshot => ({
  folders: FOLDERS,
  witnesses: FOLDERS,
  files: [repositoryFileOf(REGISTRATION_FILE, registration)],
})

const location = (spec: string, header = 'apiVersion: backstage.io/v1alpha1\nkind: Location\nmetadata:\n  name: iac\n'): string =>
  `${header}${spec}`

const violationsOf = (text: string) =>
  checkRepository(scaffolded(text)).map(({ rule, severity, message }) => [rule, severity, message])

describe('the Backstage registration', () => {
  describe('what init platform writes', () => {
    it('targets every root the path registry files entities under, and nothing written by hand', () => {
      // Read from the registry: a type added under a new root adds its target.
      // components/ joins them: the demo SI's layout, the owner's, and stage 8's
      // default for a new Component, although no operation files one there yet.
      const roots = [...ROOTS, COMPONENT_FOLDER].sort()
      expect(registrationTargets()).toEqual(
        roots.flatMap((root) => [`./${root}/**/*.yml`, `./${root}/**/*.yaml`]),
      )
      expect(roots).toEqual(['catalog', 'components', 'dependencies'])
    })

    it('is a Location Backstage reads, relative to itself, with no type of its own', () => {
      const document = parse(renderRegistration('IaC')) as Record<string, unknown>
      expect(document).toEqual({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Location',
        metadata: {
          name: 'iac',
          description: expect.stringContaining('catalog/, components/ and dependencies/') as unknown,
        },
        // No spec.type: Backstage resolves a relative target only when the type
        // is inherited from the registration that read this file.
        spec: { presence: 'optional', targets: registrationTargets() },
      })
    })

    it('conforms, and is not a document set aside', () => {
      const file = repositoryFileOf(REGISTRATION_FILE, renderRegistration('iac'))
      expect(file.ignored).toEqual([])
      expect(file.entities).toEqual([])
      expect(file.registrations).toEqual([{ faults: [], unreached: [] }])
      expect(registers(file)).toBe(true)
      expect(checkRepository(scaffolded(renderRegistration('iac')))).toEqual([])
    })

    it('is the same bytes for the same directory', () => {
      expect(renderRegistration('platform-iac')).toBe(renderRegistration('platform-iac'))
    })
  })

  describe('its name', () => {
    const GRAMMAR = /^([a-z0-9]+[-_.])*[a-z0-9]+$/

    it.each([
      ['IaC', 'iac'],
      ['platform-iac', 'platform-iac'],
      ['My Platform!!', 'my-platform'],
      ['déclarations', 'declarations'],
      ['--iac__repo..', 'iac-repo'],
    ])('derives %j as %j', (directory, name) => {
      expect(registrationName(directory)).toBe(name)
    })

    it('falls back to one name when the directory gives none Backstage accepts', () => {
      expect(registrationName('')).toBe('declarations')
      expect(registrationName('インフラ')).toBe('declarations')
    })

    it('stays inside Backstage name grammar at any length', () => {
      const name = registrationName(`${'a'.repeat(62)}-b`)
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(GRAMMAR)
    })
  })

  describe('what validate holds it to', () => {
    it('refuses a Location at the root that targets nothing', () => {
      expect(violationsOf(location('spec:\n  presence: optional\n'))).toEqual([
        ['registration', 'error', expect.stringContaining('targets nothing')],
      ])
    })

    it('refuses a Location with no spec', () => {
      expect(violationsOf(location(''))).toEqual([
        ['registration', 'error', expect.stringContaining('has no spec')],
      ])
    })

    it.each([
      ['https://github.com/acme/other/blob/main/catalog-info.yaml', 'an absolute URL'],
      ['/etc/catalog/*.yml', 'an absolute path'],
      ['./../other/**/*.yml', 'leaves the repository'],
      ['./catalog/../../x.yml', 'leaves the repository'],
      ['catalog/**/*.yml', 'does not start with ./; every target is written from ./'],
      ['', 'is empty'],
    ])('refuses the target %j: %s', (target, why) => {
      const spec = `spec:\n  targets:\n    - ${JSON.stringify(target)}\n${registrationTargets()
        .map((reached) => `    - ${reached}\n`)
        .join('')}`
      const errors = violationsOf(location(spec)).filter(([, severity]) => severity === 'error')
      expect(errors).toEqual([['registration', 'error', expect.stringContaining(why)]])
      expect(errors[0]?.[2]).toMatch(/^the Backstage registration /)
    })

    it('refuses one it cannot read: another apiVersion, a name Backstage refuses, an unknown presence', () => {
      const reached = `  targets:\n${registrationTargets().map((target) => `    - ${target}\n`).join('')}`
      expect(
        violationsOf(
          location(
            `spec:\n  presence: maybe\n${reached}`,
            'apiVersion: example.com/v1\nkind: Location\nmetadata:\n  name: "-bad-"\n',
          ),
        ).map(([, , message]) => message),
      ).toEqual([
        expect.stringContaining('apiVersion'),
        expect.stringContaining('name'),
        expect.stringContaining('presence'),
      ])
    })

    it('refuses targets that are not a list of text', () => {
      expect(violationsOf(location('spec:\n  targets: ./catalog/**/*.yml\n'))).toEqual([
        ['registration', 'error', expect.stringContaining('spec.targets')],
      ])
    })

    it('warns, naming them, when the targets leave a folder of the registry out', () => {
      // Backstage would ingest the rest and never the rights: a silent drop in
      // the catalogue, which is what this tool exists to say out loud.
      const spec = 'spec:\n  targets:\n    - ./catalog/**/*.yml\n'
      const unreached = FOLDERS.filter((folder) => !folder.startsWith('catalog/'))
      expect(violationsOf(location(spec))).toEqual([
        ['registration', 'warning', expect.stringContaining(unreached.join(', '))],
      ])
      expect(checkRepository(scaffolded(location(spec)))[0]?.severity).toBe('warning')
    })

    it('reads a single target, and one folder at a time, as reaching what they name', () => {
      const spec = `spec:\n  target: ./catalog/**/*.yml\n  targets:\n${FOLDERS.filter(
        (folder) => folder.startsWith('dependencies/'),
      )
        .map((folder) => `    - ./${folder}/*.yml\n`)
        .join('')}`
      expect(violationsOf(location(spec))).toEqual([])
    })

    it('does not count a target that only names the files a person keeps as .yaml', () => {
      // The engine files every entity as .yml.
      const spec = `spec:\n  targets:\n${ROOTS.map((root) => `    - ./${root}/**/*.yaml\n`).join('')}`
      expect(violationsOf(location(spec))).toEqual([
        ['registration', 'warning', expect.stringContaining(FOLDERS.join(', '))],
      ])
    })

    it('reads `*` as one segment and `**` as any depth, as minimatch does', () => {
      // `./catalog/*.yml` names files directly under catalog/, where the engine
      // files nothing: every entity sits one folder deeper.
      const catalog = FOLDERS.filter((folder) => folder.startsWith('catalog/'))
      const shallow = 'spec:\n  targets:\n    - ./catalog/*.yml\n    - ./dependencies/**/*.yml\n'
      expect(registrationsIn(location(shallow))[0]?.unreached).toEqual(catalog)
      const deep = 'spec:\n  targets:\n    - ./catalog/*/*.yml\n    - ./dependencies/**/*.yml\n'
      expect(registrationsIn(location(deep))[0]?.unreached).toEqual([])
    })

    it.each(['file', 'url', ''])(
      'refuses a stated spec.type %j: the relative targets are read against this file only when it states none',
      (type) => {
        const spec = `spec:\n  type: ${JSON.stringify(type)}\n  targets:\n${registrationTargets()
          .map((target) => `    - ${target}\n`)
          .join('')}`
        expect(violationsOf(location(spec))).toEqual([
          ['registration', 'error', expect.stringContaining('spec.type')],
        ])
      },
    )

    it('accepts the older apiVersion Backstage still reads', () => {
      const header = 'apiVersion: backstage.io/v1beta1\nkind: Location\nmetadata:\n  name: iac\n'
      const spec = `spec:\n  targets:\n${registrationTargets().map((target) => `    - ${target}\n`).join('')}`
      expect(violationsOf(location(spec, header))).toEqual([])
    })

    it('refuses a root Location whose kind is not written Location: Backstage never follows it', () => {
      const text = renderRegistration('iac').replace('kind: Location', 'kind: location')
      expect(violationsOf(text)).toEqual([
        ['registration', 'error', expect.stringContaining('kind: Location')],
      ])
      expect(registers(repositoryFileOf(REGISTRATION_FILE, text))).toBe(false)
    })

    it('still sets aside a Location anywhere else, as any kind it does not model', () => {
      const text = renderRegistration('iac')
      for (const where of ['catalog-info.yml', 'catalog/databases/catalog-info.yaml']) {
        const file = repositoryFileOf(where, text)
        expect(file.registrations).toBeUndefined()
        expect(file.ignored.map((document) => document.kind)).toEqual(['Location'])
      }
    })

    it('reads the other documents of the root file as it reads any file', () => {
      const component =
        'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\n' +
        'spec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n'
      const file = repositoryFileOf(REGISTRATION_FILE, `${renderRegistration('iac')}---\n${component}`)
      expect(file.entities.map((entity) => entity.metadata.name)).toEqual(['billing-api'])
      expect(file.registrations).toHaveLength(1)
      expect(file.ignored).toEqual([])
    })

    it('says a root file with no Location registers nothing', () => {
      const file = repositoryFileOf(REGISTRATION_FILE, 'apiVersion: backstage.io/v1alpha1\nkind: System\nmetadata:\n  name: x\n')
      expect(file.registrations).toBeUndefined()
      expect(registers(file)).toBe(false)
      expect(registers(undefined)).toBe(false)
    })
  })
})

/** The ```yaml blocks of a Markdown page, their list indentation taken off. */
const yamlBlocks = (page: string): string[] =>
  [...page.matchAll(/^( *)```yaml\n([\s\S]*?)^\1```$/gm)].map(([, indent = '', body = '']) =>
    body.replace(new RegExp(`^${indent}`, 'gm'), ''),
  )

describe('the configuration the pages tell a person to paste', () => {
  it.each(['docs/adopting-backstage.md', 'docs/backstage-http-brief.md'])(
    'is YAML that parses, every block of %s',
    (page) => {
      const blocks = yamlBlocks(readFileSync(page, 'utf8'))
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        const errors = parseAllDocuments(block).flatMap((document) =>
          document.errors.map((error) => error.message),
        )
        expect(errors, block).toEqual([])
      }
    },
  )

  it('shows the Location init platform writes', () => {
    const [shown] = yamlBlocks(readFileSync('docs/adopting-backstage.md', 'utf8'))
    expect(parse(shown ?? '')).toEqual(parse(renderRegistration('platform-iac')))
  })

  it('restricts the read token to entity reads, in block form', () => {
    const token = yamlBlocks(readFileSync('docs/adopting-backstage.md', 'utf8')).find((block) =>
      block.includes('externalAccess'),
    )
    expect(parse(token ?? '')).toEqual({
      backend: {
        auth: {
          externalAccess: [
            {
              type: 'static',
              options: { token: '${IDPA_CATALOG_TOKEN}', subject: 'idp-agent' },
              accessRestrictions: [{ plugin: 'catalog', permission: 'catalog.entity.read' }],
            },
          ],
        },
      },
    })
  })
})
