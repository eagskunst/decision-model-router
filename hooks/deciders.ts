import { routeQuestion } from './tiers.ts'
import type { Tiers } from './tiers.ts'
import type { Api } from './register'

export type Decision = { label: string; confidence: number; inputTokens?: number; outputTokens?: number }
export type Decider = ($: Api, text: string, tiers: Tiers) => Promise<Decision>
export type BoundDecider = (text: string, tiers: Tiers) => Promise<Decision>
export type Provider = 'subq' | 'laya' | 'claude' | 'openai-compatible'

export const TIMEOUT = 7500

export type DeciderConfig = { provider: Provider; baseUrl: string; model: string; apiKey: string }
export type DeciderTransport = {
  fetch: Api['http']['fetch']
  complete: Api['model']['complete']
}

type SystemoneAnswer = {
  choice?: unknown
  answer_confidence?: unknown
  probabilities?: Record<string, unknown>
  confidence?: unknown
}

type Usage = { input_tokens?: number; output_tokens?: number }

export class InvalidDecisionError extends Error {}

export function systemoneConfidence(answer: SystemoneAnswer): number {
  if (answer.answer_confidence !== undefined) return Number(answer.answer_confidence)
  const probabilities = Object.values(answer.probabilities ?? {}).map(Number).filter(Number.isFinite)
  if (probabilities.length) return Math.max(...probabilities)
  if (answer.confidence !== undefined) return Number(answer.confidence)
  return 0
}

function systemPrompt(tiers: Tiers) {
  const question = routeQuestion(tiers)
  const criteria = Object.entries(question.criteria).map(([label, description]) => `${label}: ${description}`).join('\n')
  return `${question.instructions}\nChoose exactly one tier from these criteria:\n${criteria}\nRespond with JSON only: {"tier":"<label>","confidence":<0..1>}`
}

function parseLlmDecision(text: string): Decision {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) throw new InvalidDecisionError('Decider returned no JSON')
  let value: { tier?: unknown; confidence?: unknown }
  try {
    value = JSON.parse(match[0]) as { tier?: unknown; confidence?: unknown }
  } catch {
    throw new InvalidDecisionError('Decider returned invalid JSON')
  }
  const label = typeof value.tier === 'string' ? value.tier : ''
  const confidence = Number(value.confidence)
  if (!label || !Number.isFinite(confidence)) throw new InvalidDecisionError('Decider returned an invalid decision')
  return { label, confidence }
}

export function createDecider(cfg: DeciderConfig, transport: DeciderTransport): BoundDecider {
  if (cfg.provider === 'subq' || cfg.provider === 'laya') {
    return async (text, tiers) => {
      const response = await transport.fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          state: text,
          model: cfg.model,
          questions: { route: routeQuestion(tiers) },
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = JSON.parse(response.text) as { answers?: { route?: SystemoneAnswer }; usage?: Usage }
      const answer = body.answers?.route ?? {}
      const label = typeof answer.choice === 'string' ? answer.choice : ''
      return {
        label,
        confidence: systemoneConfidence(answer),
        inputTokens: body.usage?.input_tokens,
      }
    }
  }

  if (cfg.provider === 'claude') {
    return async (text, tiers) => {
      const response = await transport.complete({
        model: cfg.model || 'haiku',
        system: systemPrompt(tiers),
        prompt: text,
        maxTokens: 50,
        timeoutMs: TIMEOUT,
      })
      if (!response.isAnswered) throw new Error('Claude decider did not answer')
      const decision = parseLlmDecision(response.text)
      const usage = response.usage as Usage | undefined
      return { ...decision, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens }
    }
  }

  return async (text, tiers) => {
    const response = await transport.fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt(tiers) },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 50,
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = JSON.parse(response.text) as {
      choices?: { message?: { content?: unknown } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('OpenAI-compatible decider returned no content')
    const decision = parseLlmDecision(content)
    return { ...decision, inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens }
  }
}
