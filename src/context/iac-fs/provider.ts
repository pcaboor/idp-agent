import type { ContextProvider, LoadResult } from '../provider.js'
import { readRepository } from './snapshot.js'

/**
 * A declarations repository as a `ContextProvider`: what `ask`, `graph` and
 * `show` read when `--repo` names one.
 *
 * Nothing is read here that `readRepository` does not already read, so the
 * three read commands see exactly the files `plan` and `validate` see — hidden
 * files skipped, an unreadable file rejected rather than thrown, a Group set
 * aside rather than refused. Only the provenance is narrowed: a rejection or a
 * set-aside document keeps the file it came from, which is all `LoadResult`
 * has room for, and the path stays repository-relative because it is printed
 * for a human to open.
 */
export class IacFsProvider implements ContextProvider {
  readonly name = 'iac-fs'

  constructor(private readonly root: string) {}

  async load(): Promise<LoadResult> {
    const { files, unreadable } = await readRepository(this.root)
    return {
      entities: files.flatMap((file) => [...file.entities, ...file.apis]),
      rejected: [
        // A folder it could not list is said as a file it could not read is:
        // what it holds is missing from every answer, and the reader is told.
        ...(unreadable ?? []).map((folder) => ({
          source: folder.path === '' ? '.' : folder.path,
          reason: `could not be listed (${folder.reason})`,
        })),
        ...files.flatMap((file) =>
          file.rejections.map((reason) => ({ source: file.path, reason })),
        ),
      ],
      ignored: files.flatMap((file) =>
        file.ignored.map((document) => ({ source: file.path, ...document })),
      ),
      unread: files.flatMap((file) => file.unread ?? []),
    }
  }
}
