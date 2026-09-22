import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONFIG_FILE, ConfigError, readConfig, seededVocabulary } from '../../src/cli/config.js'
import type { Vocabulary } from '../../src/core/schemas/vocabulary.js'

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-config-'))

const withConfig = async (text: string): Promise<string> => {
  const root = await temp()
  await writeFile(path.join(root, CONFIG_FILE), text, 'utf8')
  return root
}

const COMPLETE = `iacRepo: github.com/org/iac-repo
backstage: https://backstage.internal/api/catalog
environments: [dev, staging, prod]
`

const EMPTY: Vocabulary = { kinds: [], types: [], environments: [], owners: [] }

describe('.idp-agent.yml', () => {
  it('reads the three fields §7.0 declares', async () => {
    const root = await withConfig(COMPLETE)

    expect(await readConfig(root)).toEqual({
      iacRepo: 'github.com/org/iac-repo',
      backstage: 'https://backstage.internal/api/catalog',
      environments: ['dev', 'staging', 'prod'],
    })
  })

  it('reads one without the optional field', async () => {
    // §7.0 marks `backstage` optional and nothing else. A repository that has
    // not stood a Backstage up still has an IaC repository and environments.
    const root = await withConfig('iacRepo: github.com/org/iac-repo\nenvironments: [dev, prod]\n')

    const config = await readConfig(root)

    expect(config?.backstage).toBeUndefined()
    expect(config?.environments).toEqual(['dev', 'prod'])
  })

  it('returns nothing when the file is absent, which is not an error', async () => {
    // A repository that has not declared one. The vocabulary falls back to what
    // the entities show, and §7.1 is the guided tour this absence triggers.
    expect(await readConfig(await temp())).toBeUndefined()
  })

  it('names the field when a value is of the wrong shape', async () => {
    const root = await withConfig('iacRepo: github.com/org/iac-repo\nenvironments: dev\n')

    await expect(readConfig(root)).rejects.toThrow(ConfigError)
    await expect(readConfig(root)).rejects.toThrow(/environments/)
  })

  it('names the field a malformed file leaves out', async () => {
    const root = await withConfig('backstage: https://backstage.internal\n')

    await expect(readConfig(root)).rejects.toThrow(/iacRepo/)
  })

  it('names a key it does not know rather than ignoring it', async () => {
    // A typo in a committed file is silent otherwise: the vocabulary falls back
    // to the entities, and a fresh repository proposes nothing, for no stated
    // reason. Strict here is what makes that a message instead of a mystery.
    const root = await withConfig(
      'iacRepo: github.com/org/iac-repo\nenviroments: [dev]\nenvironments: [dev]\n',
    )

    await expect(readConfig(root)).rejects.toThrow(/enviroments/)
  })

  it('refuses a file that is not YAML, naming the file', async () => {
    const root = await withConfig('iacRepo: [unclosed\n')

    await expect(readConfig(root)).rejects.toThrow(new RegExp(CONFIG_FILE))
  })

  it('refuses an empty file rather than reading it as a repository with no fields', async () => {
    const root = await withConfig('\n')

    await expect(readConfig(root)).rejects.toThrow(ConfigError)
  })

  it('does not mistake a directory of that name for an absent file', async () => {
    const root = await temp()
    await mkdir(path.join(root, CONFIG_FILE))

    await expect(readConfig(root)).rejects.toThrow(ConfigError)
  })
})

describe('the vocabulary a configuration seeds', () => {
  it('gives a repository with no entities the environments it declares', async () => {
    // The whole reason this file is read here. `checkPolicies` filters the
    // request against `vocabulary.environments`, so an empty one leaves
    // `environment-mismatch` with nothing to fire on.
    const config = await readConfig(await withConfig(COMPLETE))

    expect(seededVocabulary(EMPTY, config).environments).toEqual(['dev', 'prod', 'staging'])
  })

  it('leaves every other part of the vocabulary alone', async () => {
    const config = await readConfig(await withConfig(COMPLETE))
    const held: Vocabulary = {
      kinds: ['Resource'],
      types: ['database'],
      environments: [],
      owners: ['group:default/tiger'],
    }

    expect(seededVocabulary(held, config)).toEqual({
      kinds: ['Resource'],
      types: ['database'],
      environments: ['dev', 'prod', 'staging'],
      owners: ['group:default/tiger'],
    })
  })

  it('merges rather than replaces, and states each environment once', async () => {
    // What the entities show is evidence; what the file declares is intent.
    // Neither overrides the other, and an environment in both is one value.
    const config = await readConfig(await withConfig(COMPLETE))
    const held: Vocabulary = { ...EMPTY, environments: ['prod', 'sandbox'] }

    expect(seededVocabulary(held, config).environments).toEqual([
      'dev',
      'prod',
      'sandbox',
      'staging',
    ])
  })

  it('returns the vocabulary untouched when no file declared one', () => {
    const held: Vocabulary = { ...EMPTY, environments: ['prod'] }

    expect(seededVocabulary(held, undefined)).toEqual(held)
  })
})
