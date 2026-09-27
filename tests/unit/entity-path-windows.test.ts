import { describe, expect, it, vi } from 'vitest'

/**
 * `node:path` as Windows has it, for this file only: the separator is `\`, and
 * `path.normalize` turns every `/` into one. An annotation is a path in the
 * repository, which git writes with `/` on every platform, and `validate`
 * compares what `resolveEntityPath` returns to the file's own path, `/` and
 * all. Normalised the native way, an entity filed exactly where its annotation
 * says was reported misplaced on Windows (review, product-gap-14).
 */
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual.win32, default: actual.win32 }
})

const { PathEscapeError, resolveEntityPath } = await import('../../src/core/paths/entity-path.js')
const { SOURCE_FILE_ANNOTATION } = await import('../../src/core/schemas/entity.js')
type Entity = import('../../src/core/schemas/entity.js').Entity

const annotated = (file: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'billing-db-dev', annotations: { [SOURCE_FILE_ANNOTATION]: file } },
  spec: { type: 'database', owner: 'group:default/tiger' },
})

describe('resolveEntityPath on Windows', () => {
  it('runs under the Windows path module', async () => {
    const path = await import('node:path')
    expect(path.sep).toBe('\\')
  })

  it('returns the annotation as the repository writes it, with /', () => {
    expect(resolveEntityPath(annotated('legacy/all-databases.yml'))).toBe(
      'legacy/all-databases.yml',
    )
    expect(resolveEntityPath(annotated('catalog/../legacy/./db.yml'))).toBe('legacy/db.yml')
  })

  it('still refuses a traversal, by either separator', () => {
    expect(() => resolveEntityPath(annotated('../../etc/passwd'))).toThrow(PathEscapeError)
    expect(() => resolveEntityPath(annotated('..\\..\\etc\\passwd'))).toThrow(PathEscapeError)
    expect(() => resolveEntityPath(annotated('catalog\\..\\..\\x.yml'))).toThrow(PathEscapeError)
    // `a\..` is one segment to a `/`-only normalisation, and the `..` after it
    // would cancel it: `x.yml`, where Windows reads `..\x.yml`.
    expect(() => resolveEntityPath(annotated('a\\../../x.yml'))).toThrow(PathEscapeError)
  })

  it('still refuses an absolute path, a drive letter included', () => {
    expect(() => resolveEntityPath(annotated('/etc/passwd'))).toThrow(PathEscapeError)
    expect(() => resolveEntityPath(annotated('C:\\Windows\\x.yml'))).toThrow(PathEscapeError)
    expect(() => resolveEntityPath(annotated('\\\\server\\share\\x.yml'))).toThrow(PathEscapeError)
    // Absolute only once the prefix before it normalises away.
    expect(() => resolveEntityPath(annotated('x/../C:\\x.yml'))).toThrow(PathEscapeError)
    expect(() => resolveEntityPath(annotated('x/../\\x.yml'))).toThrow(PathEscapeError)
  })
})
