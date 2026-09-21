import { describe, expect, it } from 'vitest'
import { scaffoldLayout } from '../../src/scaffold/layout.js'
import { loadTemplates } from '../../src/scaffold/templates.js'
import { isForgeHandle, renderCodeowners } from '../../src/scaffold/codeowners.js'
import { RESOURCE_TYPE_NAMES, folderOf } from '../../src/core/schemas/resource-types.js'

const layout = async () =>
  scaffoldLayout({ owner: '@acme/platform', version: '0.1.0-rc.1' }, await loadTemplates())

describe('scaffoldLayout', () => {
  it('gives every folder the registry declares a witness, not the five the design listed', async () => {
    const paths = (await layout()).map((file) => file.path)
    for (const type of RESOURCE_TYPE_NAMES) {
      expect(paths).toContain(`${folderOf(type)}/.witness.yml`)
    }
    expect(paths.filter((path) => path.endsWith('.witness.yml'))).toHaveLength(6)
  })

  it('writes the witness body the fixture SI uses, not a new one', async () => {
    const witness = (await layout()).find((file) => file.path.endsWith('.witness.yml'))
    expect(witness?.content).toContain('Declares nothing')
  })

  it('embeds the schemas rather than a link to them', async () => {
    const schema = (await layout()).find((file) => file.path === 'schemas/entity.schema.json')
    expect(JSON.parse(schema?.content ?? '{}')).toHaveProperty('$comment')
  })

  it('pins the version the generated workflow will run', async () => {
    const workflow = (await layout()).find((file) => file.path.endsWith('validate.yml'))
    expect(workflow?.content).toContain('idp-agent@0.1.0-rc.1')
    expect(workflow?.content).not.toContain('__VERSION__')
  })

  it('leaves the validation step commented out while the package is unpublished', async () => {
    // A workflow naming a package nobody can install fails on its first push
    // with no explanation. Shipping it commented, with the reason, is the same
    // admission the branch-protection block makes.
    const workflow = (await layout()).find((file) => file.path.endsWith('validate.yml'))
    expect(workflow?.content).toMatch(/^\s*# - run: npx/m)
    expect(workflow?.content).toMatch(/not published yet/i)
  })

  it('maps the dotless template to the dotfile it must become', async () => {
    // npm renames a packaged .gitignore to .npmignore, so it ships dotless.
    expect((await layout()).map((file) => file.path)).toContain('.gitignore')
  })

  it('writes no components folder, since a Component lives in its own repository', async () => {
    expect((await layout()).map((file) => file.path).join()).not.toContain('components/')
  })

  it('produces relative paths that never traverse', async () => {
    for (const file of await layout()) {
      expect(file.path.startsWith('/')).toBe(false)
      expect(file.path).not.toContain('..')
    }
  })

  it('writes twelve files', async () => {
    expect(await layout()).toHaveLength(12)
  })
})

describe('codeowners', () => {
  it('accepts a forge handle', () => {
    expect(isForgeHandle('@acme/platform')).toBe(true)
    expect(isForgeHandle('@pcaboor')).toBe(true)
  })

  it('refuses an entity owner reference, which is a different thing', () => {
    // CODEOWNERS wants @org/team; an entity wants group:default/team. One flag
    // cannot be both, and translating between them would be inference.
    expect(isForgeHandle('group:default/tiger')).toBe(false)
    expect(isForgeHandle('platform')).toBe(false)
    expect(isForgeHandle('@')).toBe(false)
    expect(isForgeHandle('')).toBe(false)
  })

  it('assigns every path, because a comment-only CODEOWNERS requires no reviewer at all', () => {
    expect(renderCodeowners('@acme/platform')).toMatch(/^\*\s+@acme\/platform$/m)
  })
})
