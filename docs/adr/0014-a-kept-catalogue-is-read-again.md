# ADR-0014 — A catalogue kept on disk is read again through the reader

**Date** 2026-09-30 · **Status** accepted · amends [ADR-0011](0011-backstage-to-explore.md)

## Context

ADR-0011 read a Backstage catalogue once per run and left a disk cache to slice 2. So every
run paid the whole read — a question, `show`, `relations`, and `idpa "<change>"`, whose
Supervisor is shown the catalogue's summary — and against a large catalogue that is eighty
pages and a second and a half before the first word of an answer, every time. A read kept on
the person's disk is company data at rest, and an input: a file anyone who can reach it can
change, read by a tool whose whole design is that nothing it reads is trusted
(`docs/backstage-http-brief.md` § 8, § 13 slice 2; `docs/plans/backstage-http-slice-2.md`,
*The cache as company data at rest*).

## Decision

**A read is kept five minutes, for the person's account alone.** Under
`$XDG_CACHE_HOME/idp-agent/backstage/`, else `~/.cache/…`, in folders `0700` and files `0600`
of the running account, never through a link below the root, every name checked for its
owner, mode, type and links before every read and write, and never repaired: a name that
fails is said with its path, and the store is not used that run. The root comes from
`bin.ts` alone (`cacheRootOf`), so no test's `main` writes under a real home; there is none
on Windows, none for root, and none with `IDP_BACKSTAGE_CACHE=off`.

**Keyed by an HMAC under a per-machine secret, sealed by a MAC over every byte.** The key is
an HMAC of the catalogue's base, the token and the read's shape, so a new token, base or
version is a new key and the token is never at rest, not even hashed. The MAC covers the
format, the key, the header — its date included — and every byte of the body.

**A copy is the raw read, minimised as the fields asked, and read again through the reader.**
An organisation item is kept as the fields its read asked for, an API's definition as
`declared`; everything else as served. Every read of a copy meets the load's own checks — its
account of its own reads, every item's uid and kind, the ceilings, the count — then the
pre-pass and `readValue`, as a page does. Only `context/backstage/provider.ts` loads the store.

**`--refresh` and `--cached`, and the age always said.** A run within five minutes answers
from the copy and says `read from cache, 3 min old; --refresh reads Backstage again`.
`--refresh` reads Backstage again. `--cached` answers from the copy whatever its age, never
asks Backstage, and says `as --cached asks: Backstage was not asked`. A run that sent no
request is traced as one: no page, no byte, and its own time.

**No automatic fall back.** A read that fails is never answered from a copy. After a failure
of reach — unreachable, a timeout, a 5xx, a 429 — the failure line names `--cached` and the
copy's age; after a 401 or a 403 it never does.

**Nothing kept reaches a plan.** The provider is built for the read road alone; a change is
decided against the declarations repository.

## Rejected alternatives

**The translated `LoadResult` on disk** — a source that passes no schema, and a file that
skips the reader. **A plain hash of the token as the key** — a short token is recovered
offline from a folder's name. **A MAC over the body alone** — the header's date would be
unsealed, turning a stale copy fresh, and a copy would read under another key. **A cache
inside the repository or in `/tmp`** — one is committed, the other shared. **An automatic
fall back to a copy** — an outage would answer with old data nobody asked for. **`--cached`
offered after a 401 or a 403** — it would route around a revocation. **A cache for root** —
one `sudo` run would leave company data in a home that none of the person's own runs may read
or remove.

## Consequences

Company data sits on the person's disk, readable by their account and the machine's
administrators, and copied by whatever copies a home — a backup, a sync tool — which
`SECURITY.md` states, with `XDG_CACHE_HOME` and `IDP_BACKSTAGE_CACHE=off` as the remedies. A
copy may lag Backstage by five minutes on top of Backstage's own lag; a token revoked inside
them keeps answering from its fresh copy until they pass, and from any copy with `--cached`:
`--refresh`, and slice 4's gate, are what prove a token still reads. A second run against a
catalogue of 20,540 entities answers in 0.4 s where the first took 1.5 s.
