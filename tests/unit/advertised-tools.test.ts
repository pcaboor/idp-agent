import { asSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { toTools } from '../../src/llm/runtime.js'
import { offeredTools } from '../support/offered-tools.js'

/**
 * Anthropic refuses a tool whose `input_schema` is not `type: "object"`, and
 * refuses a `oneOf` / `anyOf` / `allOf` at its root. The Analyst's `answer` and
 * the Reviewer's `verdict` are unions, so `ask` and plan's review gate never
 * reached that provider at all. This holds every tool an agent offers to the
 * shape all three accept — read off the agents, so a tool added tomorrow is
 * checked without anyone adding it here.
 */
describe('every tool an agent hands the client', () => {
  it('is advertised with an object root', async () => {
    const specs = await offeredTools()
    // A floor, not the list: the terminal channels are the ones that broke.
    expect(specs.map((spec) => spec.name)).toEqual(
      expect.arrayContaining(['answer', 'report_facts', 'propose', 'verdict']),
    )

    for (const spec of specs) {
      const advertised = await asSchema(toTools([spec])[spec.name]?.inputSchema).jsonSchema
      expect(advertised.type, `${spec.name} advertises no object root`).toBe('object')
      for (const key of ['oneOf', 'anyOf', 'allOf']) {
        expect(advertised, `${spec.name} advertises ${key} at its root`).not.toHaveProperty(key)
      }
    }
  })

  it('offers the overview as one more value of the answer, with no field of its own', async () => {
    const answer = (await offeredTools()).find((spec) => spec.name === 'answer')
    expect(answer).toBeDefined()
    if (answer === undefined) return
    const advertised = await asSchema(toTools([answer])['answer']?.inputSchema).jsonSchema
    expect(advertised.properties.outcome.enum).toContain('overview')
    expect(Object.keys(advertised.properties).sort()).toEqual(['outcome', 'reason', 'refs'])
  })

  it('is still validated by its own Zod schema, not by what is advertised', async () => {
    // The advertised shape of `answer` accepts {outcome: "entities"} with no
    // refs — a flat object cannot say "required in this branch". The union
    // still refuses it, and it is the union the SDK checks a call against.
    const specs = await offeredTools()
    const answer = specs.find((spec) => spec.name === 'answer')
    expect(answer).toBeDefined()
    if (answer === undefined) return
    const schema = asSchema(toTools([answer])['answer']?.inputSchema)

    expect(await schema.validate?.({ outcome: 'entities' })).toMatchObject({ success: false })
    expect(await schema.validate?.({ outcome: 'nothing' })).toEqual({
      success: true,
      value: { outcome: 'nothing' },
    })
    // The overview is a member of the flattened union too, and still the one
    // member with no field at all: the flat object offers `reason` beside it,
    // and the union refuses it there.
    expect(await schema.validate?.({ outcome: 'overview' })).toEqual({
      success: true,
      value: { outcome: 'overview' },
    })
    expect(
      await schema.validate?.({ outcome: 'overview', reason: 'a summary the model wrote' }),
    ).toMatchObject({ success: false })
  })
})
