import { zodSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { verdictSchema } from '../../src/agents/reviewer.js'
import { answerSchema, getDependenciesInputSchema } from '../../src/core/schemas/query.js'
import { objectRooted, type JsonSchema } from '../../src/llm/tool-schema.js'

/** The JSON Schema the SDK derives from a Zod schema — what `toTools` starts from. */
const derived = async (schema: z.ZodType): Promise<JsonSchema> =>
  structuredClone(await zodSchema(schema).jsonSchema)

const UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const

describe('objectRooted', () => {
  it('hands an object-rooted schema back untouched', async () => {
    const schema = await derived(getDependenciesInputSchema)
    expect(objectRooted(schema, 'get_dependencies')).toBe(schema)
  })

  it("flattens the Analyst's answer into one object a provider accepts", async () => {
    const flat = objectRooted(await derived(answerSchema), 'answer')

    expect(flat).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['entities', 'nothing', 'overview', 'unanswerable'] },
        refs: {
          minItems: 1,
          maxItems: 25,
          type: 'array',
          items: { type: 'string', pattern: '^[a-z]+:[a-z0-9-]+\\/[a-z0-9._-]+$' },
          description: 'Required when outcome is "entities"; omit it otherwise.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 300,
          description: 'Required when outcome is "unanswerable"; omit it otherwise.',
        },
      },
      required: ['outcome'],
      additionalProperties: false,
    })
  })

  it("flattens the Reviewer's verdict the same way", async () => {
    const flat = objectRooted(await derived(verdictSchema), 'verdict')

    expect(flat.type).toBe('object')
    for (const key of UNION_KEYS) expect(flat).not.toHaveProperty(key)
    expect(flat.properties?.['verdict']).toEqual({ type: 'string', enum: ['ok', 'reject'] })
    expect(flat.required).toEqual(['verdict'])
    expect(flat.properties?.['reason']).toMatchObject({
      type: 'string',
      description: 'Required when verdict is "reject"; omit it otherwise.',
    })
  })

  it('accepts an anyOf root as well as a oneOf one', async () => {
    // z.union emits anyOf, z.discriminatedUnion oneOf: the flattening is about
    // the shape of the branches, not which keyword happened to list them.
    const union = z.union([
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b') }),
    ])
    const flat = objectRooted(await derived(union), 'pick')
    expect(flat.type).toBe('object')
    expect(flat.properties?.['kind']).toEqual({ type: 'string', enum: ['a', 'b'] })
  })

  it('keeps a description a field already has, and says which branches it belongs to', async () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string().describe('The x.') }),
      z.object({ kind: z.literal('b'), x: z.string().describe('The x.').optional() }),
      z.object({ kind: z.literal('c') }),
    ])
    const flat = objectRooted(await derived(union), 'pick')
    expect(flat.properties?.['x']).toEqual({
      type: 'string',
      description: 'The x. Only when kind is "a" or "b"; required when it is "a".',
    })
  })

  it('states where a field is required, even when every branch has it', async () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), x: z.string().optional() }),
      z.object({ kind: z.literal('c'), x: z.string().optional() }),
    ])
    const flat = objectRooted(await derived(union), 'pick')
    expect(flat.required).toEqual(['kind'])
    expect(flat.properties?.['x']).toEqual({
      type: 'string',
      description: 'Required when kind is "a".',
    })
  })

  it('keeps a field every branch requires required, with no note', async () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), id: z.string() }),
      z.object({ kind: z.literal('b'), id: z.string() }),
    ])
    const flat = objectRooted(await derived(union), 'pick')
    expect(flat.required).toEqual(['kind', 'id'])
    expect(flat.properties?.['id']).toEqual({ type: 'string' })
  })

  it('offers each distinct schema of a field the branches disagree on, once', async () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), v: z.string() }),
      z.object({ kind: z.literal('b'), v: z.number() }),
      z.object({ kind: z.literal('c'), v: z.string() }),
    ])
    const flat = objectRooted(await derived(union), 'pick')
    expect(flat.properties?.['v']).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(flat.required).toEqual(['kind', 'v'])
  })

  it('writes the same bytes on every call, and leaves its input alone', async () => {
    const schema = await derived(answerSchema)
    const before = structuredClone(schema)
    const first = JSON.stringify(objectRooted(schema, 'answer'))
    expect(JSON.stringify(objectRooted(schema, 'answer'))).toBe(first)
    expect(schema).toEqual(before)
  })

  describe('refuses what it cannot flatten, naming the tool', () => {
    // A schema a provider may refuse is never sent: the run stops here, before
    // a request exists, with the name of the tool that has to change.
    it('a root that is neither an object nor a union', () => {
      expect(() => objectRooted({ type: 'string' }, 'shout')).toThrow(/tool "shout".*neither/)
    })

    it('a branch that is not an object', async () => {
      const schema = await derived(z.union([z.string(), z.object({ kind: z.literal('a') })]))
      expect(() => objectRooted(schema, 'mixed')).toThrow(/tool "mixed".*not an object/)
    })

    it('branches that share no discriminator', async () => {
      const schema = await derived(
        z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      )
      expect(() => objectRooted(schema, 'loose')).toThrow(/tool "loose".*tell the branches apart/)
    })

    it('a discriminator two branches give the same value', async () => {
      const schema = await derived(
        z.union([
          z.object({ kind: z.literal('a'), x: z.string() }),
          z.object({ kind: z.literal('a'), y: z.string() }),
        ]),
      )
      expect(() => objectRooted(schema, 'twice')).toThrow(/tool "twice".*tell the branches apart/)
    })

    it('a discriminator described differently in each branch, saying that is why', async () => {
      // The branches do share a discriminator; one enum cannot carry two
      // descriptions, and the message has to say so rather than that there is
      // nothing to tell the branches apart by.
      const schema = await derived(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('ok').describe('accept') }),
          z.object({ kind: z.literal('reject').describe('stop'), reason: z.string() }),
        ]),
      )
      expect(() => objectRooted(schema, 'judge')).toThrow(
        /tool "judge".*discriminator "kind" is described differently/,
      )
    })

    it('an object root that also carries a union', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { kind: { type: 'string' } },
        anyOf: [{ required: ['kind'] }],
      }
      expect(() => objectRooted(schema, 'both')).toThrow(/tool "both".*"anyOf"/)
    })

    it('a root keyword the flattening would drop', () => {
      const schema: JsonSchema = {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' } }, additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'b' } }, additionalProperties: false },
        ],
        definitions: { unused: { type: 'string' } },
      }
      expect(() => objectRooted(schema, 'refs')).toThrow(/tool "refs".*"definitions"/)
    })
  })
})
