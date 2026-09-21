# `scaffold/` — writing a repository into existence

This is the only layer that creates files someone else will own. Everything in it is pure
except one module.

## Why it is not in `core/`

`src/core/README.md` says nothing in `core/` may read, write, fetch or ask, and an
architecture test now enforces it. The rule engine that checks a repository belongs there;
the writer that produces one does not.

## Why exactly one file touches the disk

`write.ts` is the only module here importing `node:fs`, and a test holds that. Stage 5's
atomic applier replaces that seam: one file is a refactor, five would be a rewrite.

Everything else — deriving the file list, rendering CODEOWNERS, reading the templates into
memory — is a pure function of its arguments, and tested as one.

## Why the folder list is derived

`scaffoldLayout` builds its folders from `RESOURCE_TYPES`, never from a literal. Adding a
resource type adds its folder to every repository scaffolded afterwards, with no edit here.
`docs/design.md` §7.2 wrote the list out by hand and listed five folders against the
registry's six — that drift is the argument.

## What it never does

It never clobbers. `writeNew` uses `flag: 'wx'`, so a file that exists is kept and
reported, never overwritten and never deleted. Re-running `init platform` over a
hand-edited `CODEOWNERS` leaves it byte for byte — *absent means already done* (§4.3), and
a scaffolder that clobbers is one nobody runs twice.
