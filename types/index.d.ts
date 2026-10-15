export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The model the first prompt was routed to, and the /model it overrides. */
export type Route = {
  tier: string
  model: string
  effort: Effort
  confidence: number
  sessionModel: string
}

export type SessionRecord = {
  id: string
  startedAt: number
  provider: string
  group: 'routed' | 'holdout' | 'unrouted'
  reason?: 'short' | 'unsure' | 'offline' | 'no-key' | 'no-model'
  tier?: string
  routedModel?: string
  sessionModel: string
  confidence?: number
  decider: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }
  actualUsd: number | null
  baselineUsd: number | null
  switchOverheadUsd: number | null
  turns: number
  aborted: number
  overridden: boolean
  flagged: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'laya-router': {
      isRouted: boolean
      pending: string | null
      route: Route | null
      record: SessionRecord | null
      recordPersisted: boolean
    }
  }
}
