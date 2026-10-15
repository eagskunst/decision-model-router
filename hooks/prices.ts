export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }
export type PriceEntry = Price | { short: Price; long: Price }
export type PriceOverrides = Record<string, PriceEntry>

export const DEFAULT_PRICES: PriceOverrides = {
  'claude-fable-5-1': { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  'claude-fable-5': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-opus-5': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'claude-sonnet-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'claude-haiku-5-5': {
    short: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    long: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
  },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
}

export function parsePriceOverrides(value: string): PriceOverrides {
  if (!value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PriceOverrides) : {}
  } catch {
    return {}
  }
}

export function modelPrice(model: string, overrides: PriceOverrides = {}, tokens: Usage = {}): Price | null {
  const normalized = (model === 'haiku' ? 'claude-haiku-5-5' : model).replace(/\[[^\]]*\]$/, '')
  const prices = { ...DEFAULT_PRICES, ...overrides }
  const prefix = Object.keys(prices).filter((key) => normalized.startsWith(key)).sort((a, b) => b.length - a.length)[0]
  if (!prefix) return null
  const entry = prices[prefix]
  if ('short' in entry && 'long' in entry) {
    const totalInput = (tokens.input_tokens ?? 0) + (tokens.cache_read_input_tokens ?? 0) + (tokens.cache_creation_input_tokens ?? 0)
    return totalInput > 100_000 ? entry.long : entry.short
  }
  return entry
}

export function requestCost(usage: Usage, model: string, overrides: PriceOverrides = {}): number | null {
  const price = modelPrice(model, overrides, usage)
  if (!price) return null
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead) /
    1_000_000
  )
}
