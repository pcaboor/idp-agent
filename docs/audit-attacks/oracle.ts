/**
 * The `it` every test in this folder uses.
 *
 * A test here asserts a defect: passing means it is still open, failing means
 * it is closed. A test that throws anything but an assertion proves neither —
 * a path that moved, a fixture missing a field the code has since gained —
 * and it used to count as failing, so as closed: `turn-usage` and
 * `schema-drift` read a `docs/recordings` that never existed and reported two
 * closures, and test A's Reviewer fixture reported a third.
 *
 * So a crash is skipped, and said: `[AUDIT-CRASHED]` on stderr, and the note
 * vitest prints beside the skip. Neither open nor closed, until someone repairs
 * the test.
 */
import { it as test, type TestContext } from 'vitest'

export function it(name: string, body: (context: TestContext) => unknown, timeout?: number): void {
  test(
    name,
    async (context) => {
      try {
        await body(context)
      } catch (error) {
        if (error instanceof Error && error.name === 'AssertionError') throw error
        const first = String(error).split('\n')[0] ?? ''
        console.error(`[AUDIT-CRASHED] ${name}: ${first}`)
        context.skip(`crashed, neither open nor closed: ${first}`)
      }
    },
    timeout,
  )
}
