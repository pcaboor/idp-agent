import { describe, expect, it } from 'vitest'
import { WITNESS_KEYS, WITNESS_RULES } from '../../src/agents/tools/project-witness.js'
import { projectFactsSchema } from '../../src/agents/tools/project-tools.js'

/**
 * In a file of its own, so that a missing module fails here and not the
 * Inspector's tests: the rules themselves are exercised through `inspect`, in
 * `inspector.test.ts`'s *what a file it read states*.
 */
describe('WITNESS_RULES', () => {
  it('has a rule for every field the report carries', () => {
    // The type already makes a field without a rule a compile error; this is
    // the same check at run time, against the schema the model is handed.
    expect(Object.keys(WITNESS_RULES).sort()).toEqual(Object.keys(projectFactsSchema.shape).sort())
    const keyed = Object.entries(WITNESS_RULES)
      .filter(([, rule]) => rule === 'keyed')
      .map(([field]) => field)
      .sort()
    expect(keyed).toEqual(Object.keys(WITNESS_KEYS).sort())
  })
})
