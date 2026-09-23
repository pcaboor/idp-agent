import { it } from 'vitest'
import { z } from 'zod'
const S = (v: unknown) => JSON.stringify(v)
it('audit: which Zod changes JSON.stringify can and cannot see', () => {
  const base = z.object({ a: z.string() })
  const cases: [string, boolean][] = [
    ['.min(1) on a string', S(base) !== S(z.object({ a: z.string().min(1) }))],
    ['.max(300) vs .max(301)', S(z.string().max(300)) !== S(z.string().max(301))],
    ['.refine(fn) added', S(base) !== S(z.object({ a: z.string().refine((x) => x !== '') }))],
    ['.refine(fnA) vs .refine(fnB)', S(z.string().refine((x) => x.length > 1)) !== S(z.string().refine((x) => x.length > 2))],
    ['.describe("x") added', S(base) !== S(z.object({ a: z.string().describe('x') }))],
    ['.meta({description}) added', S(base) !== S(z.object({ a: z.string().meta({ description: 'x' }) }))],
    ['z.object vs z.strictObject', S(base) !== S(z.strictObject({ a: z.string() }))],
    ['.optional() added', S(base) !== S(z.object({ a: z.string().optional() }))],
    ['.default("d") added', S(base) !== S(z.object({ a: z.string().default('d') }))],
    ['.transform(fn) added', S(base) !== S(z.object({ a: z.string().transform((x) => x) }))],
    ['z.enum([a,b]) vs z.enum([a,c])', S(z.enum(['a', 'b'])) !== S(z.enum(['a', 'c']))],
    ['z.literal("ok") vs z.literal("okay")', S(z.literal('ok')) !== S(z.literal('okay'))],
    ['.regex(/a/) vs .regex(/b/)', S(z.string().regex(/a/)) !== S(z.string().regex(/b/))],
    ['z.array(x).max(10) vs .max(11)', S(z.array(z.string()).max(10)) !== S(z.array(z.string()).max(11))],
    ['.superRefine(fn) added', S(base) !== S(base.superRefine(() => {}))],
    ['z.lazy(() => base) vs z.lazy(() => other)', S(z.lazy(() => base)) !== S(z.lazy(() => z.object({ b: z.number() })))],
  ]
  for (const [name, seen] of cases) console.log(`[AUDIT-ZOD] ${seen ? 'SEEN   ' : 'INVISIBLE'}  ${name}`)
  console.log('[AUDIT-ZOD] string.min(1) serialises as:', S(z.string().min(1)))
  console.log('[AUDIT-ZOD] string.describe serialises as:', S(z.string().describe('x')))
  console.log('[AUDIT-ZOD] string.regex serialises as:', S(z.string().regex(/a/)))
})
