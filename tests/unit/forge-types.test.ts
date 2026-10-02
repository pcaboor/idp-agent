import { afterAll, describe, expect, it } from 'vitest'
import { openLocalForge } from '../../src/forge/local/forge.js'
import type { ForgeProvider } from '../../src/forge/provider.js'
import { removeClones } from '../support/forge-fixture.js'
import { githubClone, githubForge } from '../support/github-fixture.js'

/**
 * The type has no method (stage 6 brief § 10): typechecked by `pnpm
 * typecheck`, which reads `tests/**`, so a later widening of `ForgeProvider`
 * fails the build rather than a review.
 */

declare const forge: ForgeProvider

if (Math.random() > 2) {
  // @ts-expect-error a forge has no merge: the merge is the act of authorisation (ADR-0006)
  void forge.merge
  // @ts-expect-error a forge approves nothing
  void forge.approve
  // @ts-expect-error a forge closes nothing
  void forge.close
  // @ts-expect-error a forge deletes nothing, and moves no ref that exists (ADR-0010)
  void forge.delete
  // @ts-expect-error a forge is never handed a branch name
  void forge.submit({ branch: 'main' }, { branch: 'main', commit: '0'.repeat(40) })
}

describe('ForgeProvider', () => {
  afterAll(removeClones)

  it('holds seven members on the GitHub forge and six on the local one, and nothing that merges, approves, closes or deletes', async () => {
    const clone = await githubClone()
    const { forge: github } = await githubForge(clone)
    const local = await openLocalForge(clone.repo, 'declarations')
    // What is in flight is read on GitHub, and only read (6.3.6): the local forge has nothing to read it from.
    expect(Object.keys(github).sort()).toEqual(['base', 'diverges', 'inFlight', 'name', 'recognise', 'repository', 'submit'])
    expect(Object.keys(local).sort()).toEqual(['base', 'diverges', 'name', 'recognise', 'repository', 'submit'])
    expect(github.name).toBe('github')
    expect(local.name).toBe('local')
  })
})
