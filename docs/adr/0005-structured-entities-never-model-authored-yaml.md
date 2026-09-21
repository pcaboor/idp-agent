# ADR-0005 — structured entities, never model-authored YAML

**Date** 2026-09-21 · **Status** accepted

## Context

The AI zone chooses the content; the bytes land in an IaC repository that PyYAML and Go's
`yaml.v2` also read and that a reviewer authorises as a diff. Asked for YAML text a model emits
ambiguous scalars, and the emitter is no safer by default: six of the nine strings `no yes on off
y n true false null` read back wrong under a YAML 1.1 reader before `src/core/yaml/serialize.ts`
pinned the options, and none do after.

## Decision

The model emits a structure; the engine writes the file. `serializeEntity` (`src/core/yaml/serialize.ts`)
is the sole YAML writer, `insertDocument`/`removeDocument` (`src/core/yaml/surgery.ts`) place the
document line by line with a blank line between them, and `resolveEntityPath` picks the path.
`propose()` (design.md § 5.2) is designed, not yet built: it fills that structure, never text.

## Rejected alternative

**Let the model write the YAML and validate it afterwards** — validation comes too late for the traps in
`tests/unit/serialize.test.ts`: `no`, `on`, `y` and `0755` are valid YAML, not the strings meant. Reformatting
instead rewrites every line, where design.md § 4.3 wants one added line. And the byte-for-byte invariant in
`tests/invariants/core.test.ts` — insert a document into a hand-written file, then remove it — becomes
unstatable: a model's quoting varies per call, so a replayed branch would not remove what it inserted.

## Consequences

One format across the repository whichever model produced it, and the quoting rule is testable in
one file. The cost: a field the schemas do not model cannot be proposed at all, so a new entity
kind means editing `ordered()` in `serialize.ts` and shipping a release, not changing a prompt.
