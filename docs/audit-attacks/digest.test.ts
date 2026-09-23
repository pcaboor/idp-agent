import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

// Mirrors src/llm/runtime.ts digestOf exactly (it is not exported).
const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

describe('audit: what the recording digest covers', () => {
  it('shows what JSON.stringify makes of a Zod schema', () => {
    const before = z.object({ a: z.string() })
    const after = z.object({ a: z.string(), b: z.number() })
    const strBefore = JSON.stringify(before)
    const strAfter = JSON.stringify(after)
    console.log('[AUDIT] zod version:', (z as unknown as { version?: unknown }).version ?? 'n/a')
    console.log('[AUDIT] JSON.stringify(z.object({a: z.string()})) =', strBefore)
    console.log('[AUDIT] JSON.stringify(z.object({a: z.string(), b: z.number()})) =', strAfter)
    console.log('[AUDIT] JSON.stringify(z.string()) =', JSON.stringify(z.string()))
    console.log('[AUDIT] JSON.stringify(z.discriminatedUnion(...)) =', JSON.stringify(
      z.discriminatedUnion('verdict', [z.object({ verdict: z.literal('ok') })]),
    ))
    const req = (parameters: z.ZodType) => ({
      agent: 'architect',
      system: 'S',
      transcript: [{ role: 'user', text: 'hi' }],
      tools: [{ name: 'propose', description: 'd', parameters }],
      toolChoice: 'auto',
    })
    const d1 = digestOf(req(before))
    const d2 = digestOf(req(after))
    console.log('[AUDIT] JSON.stringify(request with schema A) =', JSON.stringify(req(before)))
    console.log('[AUDIT] digest(schema A) =', d1)
    console.log('[AUDIT] digest(schema B, new required field) =', d2)
    console.log('[AUDIT] digests equal?', d1 === d2)
    // Also: does toolChoice matter? does the tool DESCRIPTION matter?
    const d3 = digestOf({ ...req(before), toolChoice: { tool: 'propose' } })
    const d4 = digestOf({
      ...req(before),
      tools: [{ name: 'propose', description: 'changed', parameters: before }],
    })
    console.log('[AUDIT] digest differs on toolChoice?', d1 !== d3)
    console.log('[AUDIT] digest differs on tool description?', d1 !== d4)
    expect(strBefore).toBeDefined()
  })
})
