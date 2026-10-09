# `scaffold/` — writing a repository into existence

This is the only layer that creates files someone else will own. Everything in it is pure
except two modules: one reads the templates this package ships, and one writes.

## Why it is not in `core/`

`src/core/README.md` says nothing in `core/` may read, write, fetch or ask, and an
architecture test now enforces it. The rule engine that checks a repository belongs there;
the writer that produces one does not.

## Why exactly one file writes

Two modules touch the disk, for two different things. `templates.ts` *reads* the files
shipped inside the package, into memory; `write.ts` *writes* into someone else's repository,
and is the only module here importing a writing function — `mkdir`, for the directory it was
named — and the only one loading `confine/`, which makes every folder and file below it.
`tests/architecture/` names both and holds both lines: `scaffold/` imports `core/` and
`confine/`, and nothing else of ours. The writer stays the writer for a repository being created — one
being created has no branch to write to; a branch in an existing one is `forge/local/`'s
(ADR-0010).

Everything else — deriving the file list, rendering CODEOWNERS — is a pure function of its
arguments, and tested as one.

## Why the folder list is derived

`scaffoldLayout` builds its folders from `RESOURCE_TYPES`, never from a literal. Adding a
resource type adds its folder to every repository scaffolded afterwards, with no edit here.
`docs/design.md` §7.2 wrote the list out by hand and listed five folders against the
registry's six — that drift is the argument.

The Backstage registration is derived the same way: `catalog-info.yaml`'s targets come from
the registry through `core/validate/registration.ts`, which `validate` reads it back with.

## What it never does

It never clobbers. A file is created with `O_CREAT | O_EXCL` (`confine/`'s `createNew`), so
a file that exists is kept and reported, never overwritten and never deleted. Re-running `init platform` over a
hand-edited `CODEOWNERS` leaves it byte for byte — *absent means already done* (§4.3), and
a scaffolder that clobbers is one nobody runs twice.

It never writes through a symbolic link, nor outside the directory it was named
(runtime-probe-11, core-yaml-5). `assertInsideRepo` is lexical, and `catalog -> ../outside`
passed it: three witnesses were written outside. Every folder is now made one name at a
time, and a link anywhere on the way — outside, inside, to a folder or to nothing — stops the
run, named, as a file it could not write does. A link where a file goes is kept, as a file
there is: `O_EXCL` neither follows it nor creates what it names. The directory the user
named is theirs, by whatever path, a link included.

It never rolls back either, so a write that fails part-way leaves what it wrote, and says
so: `ScaffoldWriteError` carries the file it stopped at and what was written and kept before
it, and `init platform` prints that list on stdout, the reason on stderr, and exits 1. A
re-run keeps every one of those files and writes the rest. A directory that is a file is
refused before any of this, exit 2, as `init --project` refuses one.
