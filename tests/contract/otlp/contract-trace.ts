import type { Span, Trace } from '../../../src/trace/model.js'

/**
 * The trace behind accepted.json: every span type this project emits, both
 * statuses, span events, a model call with usage and one without — the cases
 * MLflow could read differently. scripts/mlflow-contract.mjs sent its encoding
 * to MLflow 3.16.1 and read every span back as sent.
 */
const T0 = 1_727_000_000_000_000_000n
const at = (ms: number): bigint => T0 + BigInt(ms) * 1_000_000n

const span = (
  fields: Pick<Span, 'spanId' | 'parentId' | 'name' | 'type' | 'start' | 'end'> & Partial<Span>,
): Span => ({
  inputs: undefined,
  outputs: undefined,
  usage: undefined,
  attributes: {},
  events: [],
  status: { code: 'OK' },
  ...fields,
})

export const CONTRACT_TRACE: Trace = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spans: [
    span({
      spanId: '0000000000000001',
      parentId: undefined,
      name: 'idp-agent ask',
      type: 'CHAIN',
      start: at(0),
      end: at(90),
      inputs: { command: 'ask', intent: 'which databases are in prod?' },
      outputs: { exitCode: 0, text: 'billing-db-prod' },
      attributes: { 'idp.mode': 'replay', 'idp.exit_code': 0 },
    }),
    span({
      spanId: '0000000000000002',
      parentId: '0000000000000001',
      name: 'supervisor',
      type: 'AGENT',
      start: at(1),
      end: at(20),
      events: [{ name: 'classified', time: at(19), attributes: { classification: 'QUESTION' } }],
    }),
    span({
      spanId: '0000000000000003',
      parentId: '0000000000000002',
      name: 'supervisor call 0',
      type: 'CHAT_MODEL',
      start: at(2),
      end: at(18),
      inputs: {
        system: 'You classify a request.',
        transcript: [{ role: 'user', text: 'request: which databases are in prod?' }],
        tools: [],
        toolChoice: 'none',
      },
      outputs: { text: 'QUESTION', toolCalls: [], finishReason: 'stop' },
      usage: { inputTokens: 120, outputTokens: 3, totalTokens: 123 },
    }),
    span({
      spanId: '0000000000000004',
      parentId: '0000000000000001',
      name: 'analyst',
      type: 'AGENT',
      start: at(21),
      end: at(80),
      events: [
        { name: 'retry', time: at(50), attributes: { agent: 'analyst', reason: 'answer: invalid outcome' } },
      ],
    }),
    span({
      spanId: '0000000000000006',
      parentId: '0000000000000004',
      name: 'analyst call 0',
      type: 'CHAT_MODEL',
      start: at(22),
      end: at(29),
      inputs: {
        system: 'You answer questions.',
        transcript: [{ role: 'user', text: 'question: which databases are in prod?' }],
        tools: [{ name: 'search_entities', description: 'find entities' }],
        toolChoice: 'auto',
      },
      outputs: {
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_entities', args: { type: 'database', env: 'prod' } }],
        finishReason: 'tool-calls',
      },
      attributes: { 'idp.usage': 'absent' },
    }),
    span({
      spanId: '0000000000000005',
      parentId: '0000000000000004',
      name: 'search_entities',
      type: 'TOOL',
      start: at(30),
      end: at(31),
      inputs: { id: 'c1', name: 'search_entities', args: { type: 'database', env: 'prod' } },
      outputs: { rows: 1, truncated: 0 },
    }),
    span({
      spanId: '0000000000000007',
      parentId: '0000000000000001',
      name: 'attempt 1',
      type: 'CHAIN',
      start: at(81),
      end: at(89),
      status: { code: 'ERROR', message: 'refused at the policy gate' },
    }),
    span({
      spanId: '0000000000000008',
      parentId: '0000000000000007',
      name: 'gate zod',
      type: 'CHAIN',
      start: at(82),
      end: at(82),
      attributes: { 'idp.attempt': 1 },
    }),
    span({
      spanId: '0000000000000009',
      parentId: '0000000000000007',
      name: 'gate policy',
      type: 'CHAIN',
      start: at(83),
      end: at(83),
      attributes: { 'idp.attempt': 1 },
      status: { code: 'ERROR', message: 'environment-mismatch at operations.0' },
    }),
  ],
}
