# Infrastructure catalogue

Every resource and every access this organisation runs is declared here, one file at a
time, and reaches production through a reviewed merge request.

```bash
git init && git add . && git commit -m "chore: scaffold the catalogue"
```

`idp-agent init platform` does not run `git init` for you: the first commit is yours.

## How it is laid out

One folder per nature, and the folder follows from the type rather than from a naming
convention. An object — a database, a cache, an API — lives under `catalog/`. A right over
an object — an access, a network route — lives under `dependencies/`.

**One file per entity.** Two people declaring two things never write the same file, so two
merge requests never conflict over one.

**A `.witness.yml` in every folder.** It declares nothing. Its absence is the point: a
pattern matching no file returns an empty set, and an empty set reads as "nothing to do".
With the witness, a folder that disappeared is a read error instead of a silent zero.

## What CI refuses

`.github/workflows/validate.yml` runs `idp-agent validate`, which refuses what the
catalogue would accept:

- two files declaring the same entity — the catalogue keeps the first and says nothing;
- an entity the schema rejects;
- two entities in one file;
- a folder holding entities with no witness;
- an entity filed somewhere other than where its type and name put it.

A reference pointing at nothing is **reported, not refused**. A repository mid-migration is
not broken, and a red build there would push someone to delete the declaration — which may
be the only trace of a network flow that is still open.

## What this tool cannot do, and says so

**It does not set branch protection.** Those settings live in the forge, and
`init platform` prints the ones required. It cannot yet verify them; the live check — that
the token which opens a request cannot merge it — arrives with the forge integration.

**It does not write a `catalog-info.yml` for an application.** That needs to read the
application's repository and propose an entity, which is a later stage of the tool.

## The rule that holds the rest up

The merge is the act of authorisation. Nothing here is applied because a tool decided it;
it is applied because a human approved a diff.
