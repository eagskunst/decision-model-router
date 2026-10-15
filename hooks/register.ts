import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Effort, Route, SessionRecord } from '../types'
import { createDecider, InvalidDecisionError, TIMEOUT } from './deciders'
import type { DeciderConfig, Provider } from './deciders'
import { parsePriceOverrides, requestCost } from './prices'
import type { Usage } from './prices'
import { persistRecord, statsText } from './stats'
import { MIN_CONFIDENCE, TIERS } from './tiers'
import type { Tiers } from './tiers'

export type Api = Parameters<Hook<'prompt.submit'>>[0] | Parameters<Hook<'turn.step'>>[0]

const isRouted = atom({ plugin: 'decision-model-router', key: 'isRouted' } as const, false)
const pending = atom({ plugin: 'decision-model-router', key: 'pending' } as const, null)
const route = atom({ plugin: 'decision-model-router', key: 'route' } as const, null)
const record = atom({ plugin: 'decision-model-router', key: 'record' } as const, null)
const recordPersisted = atom({ plugin: 'decision-model-router', key: 'recordPersisted' } as const, false)

const SKILL_TEXT_CAP = 2000

type Config = {
  provider: Provider
  decider: DeciderConfig
  tiers: Tiers
  minConfidence: number
  holdoutPercent: number
  prices: ReturnType<typeof parsePriceOverrides>
}

type UsageResult = Usage & { model?: string }

function recordFor(
  id: string,
  startedAt: number,
  provider: Provider,
  group: SessionRecord['group'],
  reason: SessionRecord['reason'],
  sessionModel: string,
  decision?: { confidence: number; inputTokens?: number; outputTokens?: number },
  decisionCost: number | null = null,
  tier?: string,
  routedModel?: string,
): SessionRecord {
  return {
    id,
    startedAt,
    provider,
    group,
    ...(reason ? { reason } : {}),
    ...(tier ? { tier } : {}),
    ...(routedModel ? { routedModel } : {}),
    sessionModel,
    ...(decision ? { confidence: decision.confidence } : {}),
    decider: { inputTokens: decision?.inputTokens ?? null, outputTokens: decision?.outputTokens ?? null, costUsd: decisionCost },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
    actualUsd: 0,
    baselineUsd: 0,
    turns: 0,
    aborted: 0,
    overridden: false,
    flagged: false,
  }
}

async function makeRecord(
  $: Api,
  cfg: Config,
  group: SessionRecord['group'],
  reason?: SessionRecord['reason'],
  decision?: { confidence: number; inputTokens?: number; outputTokens?: number },
  decisionCost: number | null = null,
  tier?: string,
  routedModel?: string,
) {
  const current = recordFor(
    await $.session.id(),
    await $.clock.now(),
    cfg.provider,
    group,
    reason,
    await $.session.model(),
    decision,
    decisionCost,
    tier,
    routedModel,
  )
  await update($, record, () => current)
  await update($, recordPersisted, () => false)
  return current
}

function deciderCost(cfg: Config, decision: { inputTokens?: number; outputTokens?: number }): number | null {
  if (cfg.provider === 'laya') return 0
  if (cfg.provider === 'openai-compatible') return null
  if (cfg.provider === 'subq') return decision.inputTokens === undefined ? null : (decision.inputTokens * 0.05) / 1_000_000
  if (decision.inputTokens === undefined || decision.outputTokens === undefined) return null
  return requestCost({ input_tokens: decision.inputTokens, output_tokens: decision.outputTokens }, cfg.decider.model || 'haiku', cfg.prices)
}

async function classify($: Api, text: string, signal: AbortSignal, cfg: Config) {
  await update($, isRouted, () => true)

  if ((cfg.provider === 'subq' || cfg.provider === 'openai-compatible') && !cfg.decider.apiKey) {
    await makeRecord($, cfg, 'unrouted', 'no-key')
    $.ui.status(`router: no API key for ${cfg.provider}, using /model`)
    return
  }
  if (cfg.provider === 'openai-compatible' && !cfg.decider.model) {
    await makeRecord($, cfg, 'unrouted', 'no-model')
    $.ui.status('router: set deciderModel, using /model')
    return
  }

  try {
    const boundDecider = createDecider(cfg.decider, {
      fetch: (url, init) => $.http.fetch(url, init),
      complete: (input) => $.model.complete(input),
    })
    const request = boundDecider(text, cfg.tiers)
    // Decider requests may outlive the hook's timeout. Race one so a stalled provider cannot hold the prompt for the
    // host's 30 s; a request that loses keeps running in the background until the host gives up.
    const timer = new AbortController()
    const timeout = $.clock.sleep(TIMEOUT, { signal: AbortSignal.any([signal, timer.signal]) }).then(() => {
      throw new Error('timeout')
    })
    const decision = await Promise.race([request, timeout]).finally(() => timer.abort())
    const [name, tier] = Object.entries(cfg.tiers).find(([, item]) => item.label === decision.label) ?? []
    const cost = deciderCost(cfg, decision)

    if (name === undefined || tier === undefined || decision.confidence < cfg.minConfidence) {
      await makeRecord($, cfg, 'unrouted', 'unsure', decision, cost)
      $.ui.status(`router: unsure (${decision.confidence.toFixed(2)}), using /model`)
      return
    }

    const sessionModel = await $.session.model()
    const chosen: Route = { tier: name, model: tier.model, effort: tier.effort, confidence: decision.confidence, sessionModel }
    if (Math.random() * 100 < cfg.holdoutPercent) {
      await makeRecord($, cfg, 'holdout', undefined, decision, cost, name)
      $.ui.status(`router: holdout (would be ${name}), using /model`)
      return
    }

    await update($, route, () => chosen)
    await makeRecord($, cfg, 'routed', undefined, decision, cost, name, tier.model)
    $.ui.status(`router → ${chosen.tier} ${decision.confidence.toFixed(2)}`)
  } catch (error) {
    if (error instanceof InvalidDecisionError) {
      await makeRecord($, cfg, 'unrouted', 'unsure', { confidence: 0 }, null)
      $.ui.status('router: unsure (0.00), using /model')
      return
    }
    await makeRecord($, cfg, 'unrouted', 'offline')
    $.ui.status('router: offline, using /model')
  }
}

function accumulateUsage(current: SessionRecord, usage: UsageResult, sentModel: string, cfg: Config): SessionRecord {
  const actual = requestCost(usage, usage.model ?? sentModel, cfg.prices)
  const baseline = requestCost(usage, current.sessionModel, cfg.prices)
  const add = (total: number | null, amount: number | null) => (total === null || amount === null ? null : total + amount)
  return {
    ...current,
    tokens: {
      input: current.tokens.input + (usage.input_tokens ?? 0),
      output: current.tokens.output + (usage.output_tokens ?? 0),
      cacheRead: current.tokens.cacheRead + (usage.cache_read_input_tokens ?? 0),
      cacheWrite: current.tokens.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
      requests: current.tokens.requests + 1,
    },
    actualUsd: add(current.actualUsd, actual),
    baselineUsd: add(current.baselineUsd, baseline),
  }
}

export const register: Register = (on, options) => {
  const provider = (String(options.provider ?? 'subq') || 'subq') as Provider
  const defaults: Record<Provider, { baseUrl: string; model: string; minConfidence: number }> = {
    subq: { baseUrl: 'https://api.subq.ai', model: 'subq-snap-preview', minConfidence: 0 },
    laya: { baseUrl: 'http://localhost:8000', model: 'jev-latest', minConfidence: 0 },
    claude: { baseUrl: '', model: 'haiku', minConfidence: 0.6 },
    'openai-compatible': { baseUrl: 'https://openrouter.ai/api/v1', model: '', minConfidence: 0.6 },
  }
  const selected = defaults[provider] ?? defaults.subq
  const apiKey = String(options.apiKey ?? '')
  const decider: DeciderConfig = {
    provider: defaults[provider] ? provider : 'subq',
    baseUrl: String(options.baseUrl ?? '') || selected.baseUrl,
    model: String(options.deciderModel ?? '') || selected.model,
    apiKey,
  }
  // Fable isn't in every subscription, so it's opt-in; without it the decider picks from the other three.
  const enableFable = String(options.enableFable ?? false) === 'true'
  // Claude Code validates each <tier>Effort against its options before load, falling back to the default.
  const tiers: Tiers = Object.fromEntries(
    Object.entries(TIERS)
      .filter(([tier]) => tier !== 'fable' || enableFable)
      .map(([tier, item]) => [tier, { ...item, effort: (options[`${tier}Effort`] as Effort | undefined) ?? item.effort }]),
  )
  const defaultConfidence =
    decider.provider === 'subq' || decider.provider === 'laya'
      ? enableFable
        ? MIN_CONFIDENCE.withFable
        : MIN_CONFIDENCE.withoutFable
      : selected.minConfidence
  const configuredConfidence = Number(options.minConfidence ?? 0)
  const minConfidence = configuredConfidence > 0 ? configuredConfidence : defaultConfidence
  const holdoutPercent = Number(options.holdoutPercent ?? 0)
  const cfg: Config = {
    provider: decider.provider,
    decider,
    tiers,
    minConfidence,
    holdoutPercent,
    prices: parsePriceOverrides(String(options.prices ?? '')),
  }

  on('prompt.submit', async ($, e, next) => {
    // ponytail: first prompt only, since every switch re-reads the whole conversation uncached.
    if (await read($, isRouted)) return next(e)
    // A skill call types as "/name args"; the skill's text only exists at skill.prompt, so classify it there.
    const name = /^\/(\S+)/.exec(e.text.trim())?.[1]
    if (
      name !== undefined &&
      (await $.command.list()).some((command) => command.name === name && (command.source === 'user' || command.source === 'plugin'))
    ) {
      await update($, pending, () => e.text.trim())
      return next(e)
    }
    // The decider reads "hi" as a confident trivial task, which would lock the session to Haiku. Routing a later prompt
    // instead would switch models mid-conversation and drop the prompt cache, so stay on /model.
    if (e.text.trim().split(/\s+/).length < 3) {
      await update($, isRouted, () => true)
      await makeRecord($, cfg, 'unrouted', 'short')
      $.ui.status('router: unsure, using /model')
      return next(e)
    }
    await classify($, e.text, next.signal, cfg)
    return next(e)
  }).catch(($, e, next) => next(e)) // routing is best effort: never hold a prompt back

  // ponytail: skill text is capped, since a SKILL.md is long and the decider only needs its gist.
  // Some accounts (e.g. team/organization) don't offer skill.prompt; turn.step then routes on the typed command.
  try {
    on('skill.prompt', async ($, e, next) => {
      const typed = await read($, pending)
      if (typed !== null && !(await read($, isRouted))) {
        await update($, pending, () => null)
        await classify($, `${typed}\n\n${e.text.slice(0, SKILL_TEXT_CAP)}`, next.signal, cfg)
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  } catch {}

  on('turn.step', async function* ($, e, next) {
    // No skill.prompt fired for the pending command (unavailable here), so route on what was typed.
    const typed = e.agentId === undefined ? await read($, pending) : null
    if (typed !== null) {
      await update($, pending, () => null)
      if (typed.split(/\s+/).length >= 3) {
        await classify($, typed, next.signal, cfg)
      } else {
        // Same rule as a plain prompt: a bare "/commit" says too little, so stay on /model.
        await update($, isRouted, () => true)
        await makeRecord($, cfg, 'unrouted', 'short')
        $.ui.status('router: unsure, using /model')
      }
    }

    const chosen = e.agentId === undefined ? await read($, route) : null
    // A manual /model after routing wins for the rest of the session.
    if (chosen !== null && (await $.session.model()) !== chosen.sessionModel) {
      await update($, route, () => null)
      const current = await read($, record)
      if (current) await update($, record, () => ({ ...current, overridden: true }))
      $.ui.status('router: /model changed, routing off')
    }
    const currentRoute = e.agentId === undefined ? await read($, route) : null
    const sentEvent = currentRoute ? { ...e, model: currentRoute.model, effort: currentRoute.effort } : e
    const result = yield* next(sentEvent)
    if (e.agentId === undefined && result.usage) {
      const current = await read($, record)
      if (current) await update($, record, () => accumulateUsage(current, result.usage as UsageResult, sentEvent.model, cfg))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const current = await read($, record)
      if (current) {
        const updated = { ...current, turns: current.turns + 1, aborted: current.aborted + (e.isAborted ? 1 : 0) }
        await update($, record, () => updated)
        const firstPersist = !(await read($, recordPersisted))
        await persistRecord($, updated, firstPersist)
        await update($, recordPersisted, () => true)
      }
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'router-bad', description: "Flag this session's route as a bad choice" })
    } catch {}
    try {
      await $.command.register({ name: 'router-stats', description: 'Show routing measurements', argumentHint: '[days]' })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'router-bad' }, async ($) => {
    const current = await read($, record)
    if (current) {
      const updated = { ...current, flagged: true }
      await update($, record, () => updated)
      const firstPersist = !(await read($, recordPersisted))
      await persistRecord($, updated, firstPersist)
      await update($, recordPersisted, () => true)
      return { text: `Flagged this session's route (${updated.tier ?? updated.group}).` }
    }
    return { text: 'No routing decision to flag for this session.' }
  })

  on('command.run', { command: 'router-stats' }, async ($, e) => ({ text: await statsText($, e.args) }))
}
