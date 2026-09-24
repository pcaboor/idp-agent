import type { ContextProvider, LoadResult } from '../provider.js'
import { readRepository } from './snapshot.js'

/**
 * A declarations repository as a `ContextProvider`: what `ask`, `graph` and
 * `show` read when `--repo` names one.
 *
 * Nothing is read here that `readRepository` does not already read, so the
 * three read commands see exactly the files `plan` and `validate` see — hidden
 * files skipped, an unreadable file rejected rather than thrown. Only the
 * provenance is narrowed: a rejection keeps the file it came from, which is
 * all `LoadResult` has room for, and the path stays repository-relative
 * because it is printed for a human to open.
 */
export class IacFsProvider implements ContextProvider {
  readonly name = 'iac-fs'

  constructor(private readonly root: string) {}

  async load(): Promise<LoadResult> {
    const { files } = await readRepository(this.root)
    return {
      entities: files.flatMap((file) => file.entities),
      rejected: files.flatMap((file) =>
        file.rejections.map((reason) => ({ source: file.path, reason })),
      ),
    }
  }
}
