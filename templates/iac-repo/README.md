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

A right may state the level it grants: `spec.access: read` or `readwrite`, and only a
right may. It is optional, because a network route has no such level and a catalogue
written before the field still validates — but an absent level is **absent**, never read
as `readwrite`. A grant whose level nobody wrote down is a grant nobody can review.

**One file per entity.** Two people declaring two things never write the same file, so two
merge requests never conflict over one.

**A `.witness.yml` in every folder.** It declares nothing. Its absence is the point: a
pattern matching no file returns an empty set, and an empty set reads as "nothing to do".
With the witness, a folder that disappeared is a read error instead of a silent zero.

## What CI refuses — once you turn it on

`.github/workflows/validate.yml` is written but **its validation step is commented out**,
because `idp-agent` is not published to a registry yet. As shipped, the workflow runs and
does nothing. Uncomment the step once the package is installable from your CI, and run
`idp-agent validate .` by hand until then.

A workflow naming a package nobody can install fails on its first push with no
explanation, which is worse than one that says it is waiting.

Once on, it refuses what the catalogue would accept:

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
