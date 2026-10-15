import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Setup = {
  status?: number
  choice?: string
  confidence?: number
  answerConfidence?: number
  probabilities?: Record<string, number>
  hang?: boolean
  inputTokens?: number
  outputTokens?: number
  content?: string
  modelText?: string
  response?: unknown
}

function world(on: On, setup: Setup = {}) {
  const sent: { model: string; effort?: unknown }[] = []
  const calls: { url: string; init?: { body?: string; headers?: Record<string, string> } }[] = []
  const statuses: (string | undefined)[] = []
  const saved = new Map<string, unknown>()
  let sessionModel = 'claude-opus-5-5'
  let usage: unknown = null
  let modelText = setup.modelText ?? '{"tier":"hard","confidence":0.8}'

  on('http.fetch', ($, e) => {
    calls.push({ url: e.url, init: e.init })
    if (setup.hang) return new Promise(() => {})
    const body =
      setup.response ??
      (e.url.endsWith('/chat/completions')
        ? {
            choices: [{ message: { content: setup.content ?? '{"tier":"trivial","confidence":0.9}' } }],
            usage: { prompt_tokens: setup.inputTokens ?? 12, completion_tokens: setup.outputTokens ?? 4 },
          }
        : {
            answers: {
              route: {
                choice: setup.choice ?? 'trivial',
                ...(setup.answerConfidence !== undefined ? { answer_confidence: setup.answerConfidence } : {}),
                ...(setup.probabilities ? { probabilities: setup.probabilities } : {}),
                confidence: setup.confidence ?? 0.9,
              },
            },
            usage: { input_tokens: setup.inputTokens ?? 100, output_tokens: setup.outputTokens ?? 0 },
          })
    return {
      value: {
        status: setup.status ?? 200,
        ok: (setup.status ?? 200) < 300,
        headers: {},
        text: JSON.stringify(body),
      },
    }
  })
  on('clock.sleep', () => (setup.hang ? { value: undefined } : new Promise(() => {})))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.model', () => ({ value: sessionModel }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: modelText,
      usage: { input_tokens: setup.inputTokens ?? 100, output_tokens: setup.outputTokens ?? 20 },
    },
  }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  return {
    sent,
    calls,
    statuses,
    saved,
    setModel: (model: string) => (sessionModel = model),
    setUsage: (value: unknown) => (usage = value),
    setModelText: (text: string) => (modelText = text),
  }
}

function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, agentId?: string, model = 'claude-opus-5-5') {
  const stream = $.turn.step({
    turnId: 't',
    index: 0,
    model,
    effort: 'high',
    messageCount: 1,
    ...(agentId ? { agentId } : {}),
  })
  for await (const _ of stream) {}
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function complete($: Engine, isAborted = false) {
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 10, isAborted, usage: null })
}

function stored(w: ReturnType<typeof world>) {
  return [...w.saved.values()][0] as {
    group: string
    tier?: string
    reason?: string
    actualUsd: number | null
    baselineUsd: number | null
    tokens: { requests: number; input: number }
    overridden: boolean
    flagged: boolean
    [key: string]: unknown
  }
}

test('routes the session from its first prompt only', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  await submit($, 'Translate hello into French.')
  await step($)
  await submit($, 'Now prove the Riemann hypothesis.')
  await step($)
  expect(w.calls.length).toBe(1)
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').state).toBe('Translate hello into French.')
  expect(w.sent).toEqual([
    { model: 'claude-haiku-5-5', effort: 'low' },
    { model: 'claude-haiku-5-5', effort: 'low' },
  ])
})

test('leaves subagents alone', { options: { provider: 'laya', enableFable: true } }, async ($, on) => {
  const w = world(on, { choice: 'research', confidence: 0.7 })
  await submit($, 'Invent a new theory of dark matter.')
  await step($, 'agent-1')
  await step($)
  expect(w.sent).toEqual([
    { model: 'claude-opus-5-5', effort: 'high' },
    { model: 'claude-fable-5-1', effort: 'xhigh' },
  ])
})

test('leaves Fable out unless enabled', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { choice: 'research' })
  await submit($, 'Invent a new theory of dark matter.')
  await step($)
  const criteria = JSON.parse(w.calls[0]?.init?.body ?? '').questions.route.criteria
  expect(Object.keys(criteria)).toEqual(['trivial', 'routine', 'hard'])
  expect(criteria.hard.endsWith(', new theory, formal proof')).toBe(true)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('uses the configured effort per tier', { options: { provider: 'laya', opusEffort: 'max' } }, async ($, on) => {
  const w = world(on, { choice: 'hard' })
  await submit($, 'Why does this deadlock only under load?')
  await step($)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'max' }])
})

test('keeps /model when the decision is unsure', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { confidence: 0.39 })
  await submit($, 'Help me with my thing.')
  await step($)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  expect(w.statuses).toEqual(['router: unsure (0.39), using /model'])
})

test('keeps /model for a first prompt under three words', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  await submit($, 'hi there')
  await step($)
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls.length).toBe(0)
  expect(w.sent.map((request) => request.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.statuses).toEqual(['router: unsure, using /model'])
})

test('keeps /model when the provider is down', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { status: 503 })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  expect(w.statuses).toEqual(['router: offline, using /model'])
})

test('times out an unresponsive provider', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { hang: true })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  expect(w.statuses).toEqual(['router: offline, using /model'])
})

test('a manual /model switch turns routing off', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  await submit($, 'Translate hello into French.')
  await step($)
  w.setModel('claude-sonnet-5-5')
  await step($)
  w.setModel('claude-opus-5-5')
  await step($)
  expect(w.sent.map((request) => request.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('uses laya-serve URL and optional API key', { options: { provider: 'laya', baseUrl: 'http://laya:9000/', apiKey: 's3cret' } }, async ($, on) => {
  const w = world(on, { status: 503 })
  await submit($, 'Translate hello into French.')
  expect(w.calls[0]?.url).toBe('http://laya:9000/v1/systemone')
  expect(w.calls[0]?.init?.headers?.authorization).toBe('Bearer s3cret')
})

test('routes a skill call from its expanded text', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { choice: 'hard' })
  on('command.list', () => ({ value: [{ name: 'implement-issue', description: '', source: 'user' }] }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  await submit($, '/implement-issue 12345')
  expect(w.calls.length).toBe(0)
  await $.skill.prompt({ skill: 'implement-issue', text: 'Implement the issue.' })
  await step($)
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').state).toBe('/implement-issue 12345\n\nImplement the issue.')
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('routes a skill call from typed text if skill.prompt does not fire', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { choice: 'hard' })
  on('command.list', () => ({ value: [{ name: 'implement-issue', description: '', source: 'user' }] }))
  await submit($, '/implement-issue fix the flaky login test')
  await step($)
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').state).toBe('/implement-issue fix the flaky login test')
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('keeps /model after a bare skill command', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  on('command.list', () => ({ value: [{ name: 'commit', description: '', source: 'plugin' }] }))
  await submit($, '/commit')
  await step($)
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls.length).toBe(0)
  expect(w.sent.map((request) => request.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.statuses).toEqual(['router: unsure, using /model'])
})

test('defaults to SubQ systemone and uses top probability confidence', { options: { apiKey: 'subq-secret' } }, async ($, on) => {
  const w = world(on, { choice: 'trivial', confidence: 0.5, probabilities: { trivial: 0.9, routine: 0.05, hard: 0.05 } })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls[0]?.url).toBe('https://api.subq.ai/v1/systemone')
  expect(w.calls[0]?.init?.headers?.authorization).toBe('Bearer subq-secret')
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').model).toBe('subq-snap-preview')
  expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
})

test('unknown providers use the SubQ defaults', { options: { provider: 'unknown', apiKey: 'subq-secret' } }, async ($, on) => {
  const w = world(on, { choice: 'trivial', confidence: 0.4 })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls[0]?.url).toBe('https://api.subq.ai/v1/systemone')
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').model).toBe('subq-snap-preview')
  expect(w.statuses[0]).toBe('router: unsure (0.40), using /model')
  expect(w.sent[0]?.model).toBe('claude-opus-5-5')
})

test('does not call SubQ without its API key', async ($, on) => {
  const w = world(on)
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls.length).toBe(0)
  expect(w.sent[0]?.model).toBe('claude-opus-5-5')
  expect(w.statuses[0]).toBe('router: no API key for subq, using /model')
})

test('laya uses its default endpoint/model and answer_confidence', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on, { choice: 'trivial', answerConfidence: 0.9, confidence: 0.39 })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls[0]?.url).toBe('http://localhost:8000/v1/systemone')
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').model).toBe('jev-latest')
  expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
})

test('uses baseUrl and deciderModel overrides', { options: { provider: 'laya', baseUrl: 'https://router.example/api/', deciderModel: 'custom-decider' } }, async ($, on) => {
  const w = world(on)
  await submit($, 'Translate hello into French.')
  expect(w.calls[0]?.url).toBe('https://router.example/api/v1/systemone')
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').model).toBe('custom-decider')
})

test('uses Claude model.complete for routing', { options: { provider: 'claude' } }, async ($, on) => {
  const w = world(on, { modelText: '{"tier":"trivial","confidence":0.8}' })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls.length).toBe(0)
  expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
})

test('treats invalid Claude output as unsure', { options: { provider: 'claude' } }, async ($, on) => {
  const w = world(on, { modelText: 'not json' })
  await submit($, 'Why does this deadlock only under load?')
  await step($)
  expect(w.statuses).toEqual(['router: unsure (0.00), using /model'])
})

test('uses OpenAI-compatible chat completions', { options: { provider: 'openai-compatible', apiKey: 'api-secret', baseUrl: 'https://example.test/v1', deciderModel: 'my-router' } }, async ($, on) => {
  const w = world(on, { content: '{"tier":"trivial","confidence":0.9}' })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.calls[0]?.url).toBe('https://example.test/v1/chat/completions')
  expect(w.calls[0]?.init?.headers?.authorization).toBe('Bearer api-secret')
  expect(JSON.parse(w.calls[0]?.init?.body ?? '').model).toBe('my-router')
  expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
})

test('does not call OpenAI-compatible without deciderModel', { options: { provider: 'openai-compatible', apiKey: 'api-secret' } }, async ($, on) => {
  const w = world(on)
  await submit($, 'Translate hello into French.')
  expect(w.calls.length).toBe(0)
  expect(w.statuses[0]).toBe('router: set deciderModel, using /model')
})

test('supports a minimum confidence override', { options: { provider: 'laya', minConfidence: 0.95 } }, async ($, on) => {
  const w = world(on, { confidence: 0.9 })
  await submit($, 'Translate hello into French.')
  await step($)
  expect(w.sent[0]?.model).toBe('claude-opus-5-5')
  expect(w.statuses[0]).toBe('router: unsure (0.90), using /model')
})

test('holds out confident decisions and records the candidate tier', { options: { provider: 'laya', holdoutPercent: 100 } }, async ($, on) => {
  const w = world(on)
  await submit($, 'Translate hello into French.')
  await step($)
  await complete($)
  expect(w.sent[0]?.model).toBe('claude-opus-5-5')
  expect(w.statuses[0]).toBe('router: holdout (would be haiku), using /model')
  expect(stored(w)).toMatchObject({ group: 'holdout', tier: 'haiku' })
})

test('records costs and no prompt text', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  w.setUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 })
  await submit($, 'Translate hello into French.')
  await step($)
  await complete($)
  const serialized = JSON.stringify(stored(w))
  expect(stored(w)).toMatchObject({ actualUsd: 0.0006, baselineUsd: 0.024 })
  expect(serialized.includes('Translate hello into French.')).toBe(false)
})

test('does not count subagent usage', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  w.setUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await submit($, 'Translate hello into French.')
  await step($, 'agent-1')
  await complete($)
  expect(stored(w).tokens).toMatchObject({ requests: 0, input: 0 })
})

test('records manual overrides, bad-route flags, and stats', { options: { provider: 'laya' } }, async ($, on) => {
  const w = world(on)
  w.setUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await start($)
  await submit($, 'Translate hello into French.')
  w.setModel('claude-sonnet-5-5')
  await step($, undefined, 'claude-sonnet-5-5')
  await complete($)
  await $.command.run({ command: 'router-bad', args: '' })
  const stats = await $.command.run({ command: 'router-stats', args: '' })
  expect(stored(w)).toMatchObject({ overridden: true, flagged: true })
  expect(stats.text).toContain('$0.0070')
})

test('custom prices override built-in prices', { options: { provider: 'laya', prices: '{"claude-haiku-5-5":{"input":1,"output":10,"cacheWrite":1,"cacheRead":0.1}}' } }, async ($, on) => {
  const w = world(on)
  w.setUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await submit($, 'Translate hello into French.')
  await step($)
  await complete($)
  expect(stored(w).actualUsd).toBe(0.006)
})
