import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { LlmClient } from '../../src/llm/client.js'

/**
 * Every keyless command the README shows, run as it is typed there, and its
 * output held to what the README prints, byte for byte — stderr first, as a
 * terminal shows it. The first screen is what a newcomer reads before deciding
 * whether to go on, and an output pasted there that the code no longer prints
 * would be read as the behaviour.
 *
 * A block counts when it is a `text` block whose first line is
 * `$ node dist/cli/bin.js …`: those are the commands a fresh clone runs with
 * no key. The model-backed examples are `console` blocks, and the one of them
 * the engine's part of which can be pinned is held by `ask-commentary.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')

const blocks = [...README.matchAll(/^```text\n\$ node dist\/cli\/bin\.js ([^\n]*)\n([\s\S]*?)^```$/gm)].map(
  (match) => ({ command: match[1]!, shown: match[2]! }),
)

/** A command that reached for a model would not be keyless. */
const untouchable: LlmClient = {
  generate: () => {
    throw new Error('a README command the README calls keyless called a model')
  },
}

describe("the README's keyless commands", () => {
  it('are there to check: the first screen shows at least three', () => {
    expect(blocks.map(({ command }) => command)).toEqual(
      expect.arrayContaining([
        'relations mysql-prod-01 --impacts --demo',
        'plan --from examples/declare-cache.json --repo fixtures/si-demo',
        'plan --from examples/needs-an-owner.json --repo fixtures/si-demo',
      ]),
    )
  })

  it('run from the root of the clone, where the README types them', () => {
    // `plan` resolves a relative --from and --repo against the process's own
    // directory, which is where vitest runs.
    expect(process.cwd()).toBe(ROOT)
  })

  it.each(blocks)('$ node dist/cli/bin.js $command', async ({ command, shown }) => {
    // Plain words and flags only: a quoted argument would need a shell to split.
    expect(command).not.toMatch(/["'\\]/)
    const out: string[] = []
    const err: string[] = []
    await main(command.split(' '), {
      cwd: ROOT,
      env: {},
      client: untouchable,
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      events: () => {},
    })
    expect(err.join('') + out.join('')).toBe(shown)
  })
})
