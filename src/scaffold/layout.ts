import { RESOURCE_TYPE_NAMES, folderOf } from '../core/schemas/resource-types.js'
import { entityJsonSchema, planJsonSchema } from '../core/schemas/json-schema.js'
import { renderCodeowners } from './codeowners.js'

export interface ScaffoldFile {
  /** Repository-relative, POSIX. Never absolute, never traversing. */
  readonly path: string
  readonly content: string
}

export interface ScaffoldOptions {
  /** A forge handle — `@user` or `@org/team`. Not an entity owner reference. */
  readonly owner: string
  /** The version the generated workflow pins. */
  readonly version: string
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const required = (templates: ReadonlyMap<string, string>, name: string): string => {
  const body = templates.get(name)
  if (body === undefined) throw new Error(`missing template: ${name}`)
  return body
}

/**
 * Pure. The folder list comes from the resource-type registry and never from a
 * literal: adding a type adds its folder, and a list written out here would
 * drift from the code the first time one is added. design 7.2 listed five
 * folders against the registry's six, which is exactly how that goes.
 */
export function scaffoldLayout(
  options: ScaffoldOptions,
  templates: ReadonlyMap<string, string>,
): ScaffoldFile[] {
  const witness = required(templates, 'witness.yml')
  const folders = [...new Set(RESOURCE_TYPE_NAMES.map(folderOf))].sort()

  return [
    ...folders.map((folder) => ({ path: `${folder}/.witness.yml`, content: witness })),
    { path: 'schemas/entity.schema.json', content: json(entityJsonSchema()) },
    { path: 'schemas/plan.schema.json', content: json(planJsonSchema()) },
    {
      path: '.github/workflows/validate.yml',
      content: required(templates, 'github/workflows/validate.yml').replaceAll(
        '__VERSION__',
        options.version,
      ),
    },
    { path: 'CODEOWNERS', content: renderCodeowners(options.owner) },
    { path: 'README.md', content: required(templates, 'README.md') },
    // Stored dotless in the package, written as the dotfile it must be.
    { path: '.gitignore', content: required(templates, 'gitignore') },
  ]
}
