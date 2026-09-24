import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Span, Trace } from '../../src/trace/model.js'
import { toOtlpJson } from '../../src/trace/otlp.js'
import { CONTRACT_TRACE } from '../contract/otlp/contract-trace.js'

const ACCEPTED = path.resolve(import.meta.dirname, '../contract/otlp/accepted.json')

/** The contract's root alone, with some of its fields replaced. */
const rootWith = (fields: Partial<Span>): Trace => ({
  traceId: CONTRACT_TRACE.traceId,
  spans: [{ ...(CONTRACT_TRACE.spans[0] as Span), ...fields }],
})

interface Attribute {
  key: string
  value: unknown
}
const attributesOf = (body: unknown): Attribute[] =>
  (body as { resourceSpans: { scopeSpans: { spans: { attributes: Attribute[] }[] }[] }[] })
    .resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes ?? []

describe('toOtlpJson', () => {
  it('encodes the contract trace exactly as the MLflow it pins accepted it', async () => {
    // accepted.json was read back span by span through MLflow 3.16.1's own
    // client (scripts/mlflow-contract.mjs). An encoder that drifts from it is
    // sending MLflow something nobody has seen it read.
    expect(toOtlpJson(CONTRACT_TRACE, { serviceVersion: '0.0.0-contract' })).toEqual(
      JSON.parse(await readFile(ACCEPTED, 'utf8')),
    )
  })

  it('writes nothing for what was not recorded, rather than a null', () => {
    const keys = attributesOf(
      toOtlpJson(rootWith({ inputs: undefined, outputs: undefined, attributes: {} }), {
        serviceVersion: 'x',
      }),
    ).map((attribute) => attribute.key)
    expect(keys).toEqual(['mlflow.spanType'])
  })

  it('writes only the token counts the provider reported', () => {
    const usage = attributesOf(
      toOtlpJson(rootWith({ usage: { outputTokens: 3 } }), { serviceVersion: 'x' }),
    ).find((attribute) => attribute.key === 'mlflow.chat.tokenUsage')
    expect(usage).toEqual({
      key: 'mlflow.chat.tokenUsage',
      value: { stringValue: '{"output_tokens":3}' },
    })
  })

  it('types the project’s own attributes, where MLflow’s carry JSON', () => {
    const attributes = attributesOf(
      toOtlpJson(
        rootWith({
          inputs: undefined,
          outputs: undefined,
          attributes: { 'idp.mode': 'live', 'idp.exit_code': 1, 'idp.ratio': 0.5, 'idp.flag': true },
        }),
        { serviceVersion: 'x' },
      ),
    )
    expect(attributes).toEqual([
      { key: 'mlflow.spanType', value: { stringValue: '"CHAIN"' } },
      { key: 'idp.mode', value: { stringValue: 'live' } },
      { key: 'idp.exit_code', value: { intValue: '1' } },
      { key: 'idp.ratio', value: { doubleValue: 0.5 } },
      { key: 'idp.flag', value: { boolValue: true } },
    ])
  })

  it('sends an integer only where int64 holds it exactly, and a number JSON cannot carry as text', () => {
    // 1e21 is an integer to JavaScript and `"1e+21"` to int64, which is no
    // integer at all; NaN and Infinity have no JSON number to travel as.
    const attributes = attributesOf(
      toOtlpJson(
        rootWith({
          inputs: undefined,
          outputs: undefined,
          attributes: {
            'idp.safe': Number.MAX_SAFE_INTEGER,
            'idp.huge': 1e21,
            'idp.nan': Number.NaN,
            'idp.up': Number.POSITIVE_INFINITY,
            'idp.down': Number.NEGATIVE_INFINITY,
          },
        }),
        { serviceVersion: 'x' },
      ),
    )
    expect(attributes).toEqual([
      { key: 'mlflow.spanType', value: { stringValue: '"CHAIN"' } },
      { key: 'idp.safe', value: { intValue: '9007199254740991' } },
      { key: 'idp.huge', value: { doubleValue: 1e21 } },
      { key: 'idp.nan', value: { stringValue: 'NaN' } },
      { key: 'idp.up', value: { stringValue: 'Infinity' } },
      { key: 'idp.down', value: { stringValue: '-Infinity' } },
    ])
  })
})
