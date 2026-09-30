# `confine/` — the one place a path is confined on the disk

A leaf of one module. `assertInsideRepo` in `core/paths` confines a path by its name, and
has to: `core/` touches no disk. A name cannot say that `catalog` is a symbolic link to
`../outside`, and the review measured what that cost (batch B3): `init platform` wrote three
witnesses outside the directory it was given, `iac-fs` read an entity from wherever a linked
`.yml` pointed and dropped a linked folder in silence, and `plan` diffed the linked file. What
a name leads to is a fact about the disk, and this module is where the disk is asked.

## What lives here

| file | what it is |
|---|---|
| `confine.ts` | `realRootOf`, the root every path is judged against; `followInside`, where a link leads — nowhere, outside, or a real path inside; `openToRead`, a descriptor that is never a link (`O_NOFOLLOW`) and still names the file inside the root once open; `makeFolders`, one name at a time, never through a link, with the mode a caller asks; `openNew` and `createNew`, `O_CREAT \| O_EXCL \| O_NOFOLLOW` with the same check once open, `openNew` with the mode a caller asks; `LinkRefused`, the refusal naming the link, never its target; `isInside` |

## Who calls it, and what each follows

- `context/project-fs/snapshot.ts` follows a link that stays inside the application
  repository — a monorepo links a shared config into a package — and refuses one that
  leaves it: `followInside`, then `openToRead`.
- `context/iac-fs/snapshot.ts` follows none: a declarations repository holds no link, and a
  reviewer reads the file a link names, not the file it leads to. `openToRead` refuses a
  linked `.yml` by name; the walk names every other link as a link it did not follow.
  `readRepositoryText`, beside the walk, is how `plan` reads the same files' bytes.
- `scaffold/write.ts` writes through none: `makeFolders` and `createNew`. A link where a
  file goes is kept, as a file there is — `O_EXCL` neither follows it nor creates what it
  names.
- `context/backstage/cache.ts` follows none below the person's cache root, and makes what it
  makes closed to every other account: folders `makeFolders(…, { mode: 0o700 })`, a copy or
  the secret `openNew(…, { mode: 0o600 })` under a temporary name it then renames into
  place, and `openToRead(…, { nonBlocking: true })` to read one back, so a named pipe at
  the name is opened at once and refused as not a file rather than waited on for a writer
  that never comes. The `mode` and `nonBlocking` options are the cache's alone; with none,
  `makeFolders`, `openNew` and `openToRead` do what they always did, which `init platform`,
  `iac-fs` and `project-fs` rely on.

The directory a user named is theirs, by whatever path they named it: a temporary directory
on macOS is reached through `/var`, itself a link. Below it, nothing is taken on trust.

## What it does not close

`O_NOFOLLOW` guards the last name of a path and nothing above it, and Node has no `openat` to
hold a folder still while a file in it is opened. So every open is checked once the
descriptor exists — no folder between the root and the file a link, wherever it leads, and
the name still naming the inode that was opened — and refused before a byte is read or
written; `makeFolders` asks every folder above a name again after each one it makes. What
`mkdir` or an exclusive create made in that instant, through a folder swapped for a link,
is one empty folder or one empty file, and the refusal names the path. A folder swapped for
a link and back again between two of these checks is not caught: that instant is the one
only `openat` closes. `SECURITY.md` says so. On Windows `O_NOFOLLOW` does not exist, and the checks
around the open are the whole guard.

## What may not

Nothing here imports anything of ours, nor any package: `node:` built-ins only, because
`scaffold/` may import `core/` and this leaf and nothing else of ours, and anything this
leaf imported would be reachable from all four of its importers.
`tests/architecture/dependencies.test.ts` holds that (*confine/ imports nothing of ours, and
only node: built-ins*), holds its importers to the four above (*only scaffold/write.ts,
context/iac-fs, context/project-fs and context/backstage/cache.ts load confine/*) —
`createNew` writes and `openToRead` reads with no fs function in the caller's source, so a
fifth importer would be a writer and a reader no other rule sees — and names the two
writing calls it makes, `mkdir` and `open` (*only the named modules write, and only one
starts a process*). `core/` may not
import this folder, directly or through anything else. `tests/unit/confine.test.ts` stages
what only the primitive can: a link planted between the check and the open.
