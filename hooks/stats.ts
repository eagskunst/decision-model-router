import type { Api } from './register'
import type { SessionRecord } from '../types'

export function sessionKey(record: SessionRecord, id: string) {
  return `session:${String(record.startedAt).padStart(13, '0')}:${id}`
}

export async function persistRecord($: Api, record: SessionRecord, prune: boolean) {
  const key = sessionKey(record, await $.session.id())
  await $.store.set(key, record)
  if (!prune) return

  const keys = await $.store.keys()
  const sessions = keys.filter((value: string) => value.startsWith('session:')).sort().reverse()
  for (const expired of sessions.slice(500)) await $.store.delete(expired)
}

async function allRecords($: Api, days?: number): Promise<SessionRecord[]> {
  const cutoff = days === undefined ? undefined : (await $.clock.now()) - days * 86_400_000
  const keys = await $.store.keys()
  const records: SessionRecord[] = []
  for (const key of keys.filter((value: string) => value.startsWith('session:'))) {
    const value = (await $.store.get(key)) as SessionRecord | undefined
    if (value && (cutoff === undefined || value.startedAt >= cutoff)) records.push(value)
  }
  return records
}

const money = (value: number | null) => (value === null ? 'unpriced' : `$${value.toFixed(4)}`)
const percent = (value: number, total: number) => (total ? `${((value / total) * 100).toFixed(0)}%` : '—')
const average = (total: number, count: number) => (count ? (total / count).toFixed(2) : '—')

export async function statsText($: Api, daysArg: string): Promise<string> {
  const parsedDays = Number(daysArg)
  const days = daysArg.trim() && Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : undefined
  const records = await allRecords($, days)
  const groups = ['routed', 'holdout', 'unrouted'] as const
  const lines = [
    `## Router stats${days ? ` (last ${days} days)` : ''}`,
    '',
    '| Group | Sessions | Avg turns | Aborted | Overridden | Flagged | Avg actual/session |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ]

  for (const group of groups) {
    const rows = records.filter((record) => record.group === group)
    const knownActual = rows.filter((record) => record.actualUsd !== null)
    lines.push(
      `| ${group} | ${rows.length} | ${average(rows.reduce((sum, row) => sum + row.turns, 0), rows.length)} | ` +
        `${percent(rows.reduce((sum, row) => sum + row.aborted, 0), rows.reduce((sum, row) => sum + row.turns, 0))} | ` +
        `${percent(rows.filter((row) => row.overridden).length, rows.length)} | ` +
        `${percent(rows.filter((row) => row.flagged).length, rows.length)} | ` +
        `${knownActual.length ? money(knownActual.reduce((sum, row) => sum + (row.actualUsd ?? 0), 0) / knownActual.length) : 'unpriced'} |`,
    )
  }

  const routed = records.filter((record) => record.group === 'routed')
  const pricedRouted = routed.filter((record) => record.actualUsd !== null && record.baselineUsd !== null)
  const actualTotal = pricedRouted.reduce((sum, record) => sum + (record.actualUsd ?? 0), 0)
  const baselineTotal = pricedRouted.reduce((sum, record) => sum + (record.baselineUsd ?? 0), 0)
  const saved = baselineTotal - actualTotal
  const routedDeciderCosts = routed.map((record) => record.decider.costUsd)
  const deciderTotal = routedDeciderCosts.every((cost) => cost !== null)
    ? money(routedDeciderCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0))
    : `${routed.reduce((sum, record) => sum + (record.decider.inputTokens ?? 0), 0)} input / ${routed.reduce((sum, record) => sum + (record.decider.outputTokens ?? 0), 0)} output tokens (some unpriced)`
  const tiers = new Map<string, number>()
  for (const record of routed) if (record.tier) tiers.set(record.tier, (tiers.get(record.tier) ?? 0) + 1)
  const tierLine = [...tiers].map(([tier, count]) => `${tier} ${count}`).join(', ') || '—'
  lines.push(
    '',
    `**Routed totals:** actual ${money(actualTotal)}; baseline ${money(baselineTotal)}; saved ${money(saved)} (${baselineTotal ? `${((saved / baselineTotal) * 100).toFixed(1)}%` : '—'}); decider ${deciderTotal}.`,
    `**Tiers:** ${tierLine}.`,
  )

  const holdout = records.filter((record) => record.group === 'holdout')
  if (routed.length && holdout.length) {
    const avgCost = (rows: SessionRecord[]) => {
      const known = rows.filter((record) => record.actualUsd !== null)
      return known.length ? money(known.reduce((sum, record) => sum + (record.actualUsd ?? 0), 0) / known.length) : 'unpriced'
    }
    lines.push(
      `**Routed vs holdout:** avg actual ${avgCost(routed)} vs ${avgCost(holdout)} per session; avg turns ${average(routed.reduce((sum, record) => sum + record.turns, 0), routed.length)} vs ${average(holdout.reduce((sum, record) => sum + record.turns, 0), holdout.length)}.`,
    )
  }
  lines.push(
    '',
    `Unpriced actual or baseline models: ${records.filter((record) => record.actualUsd === null || record.baselineUsd === null).length} session(s). Baseline is an estimate: the same observed tokens repriced at the session's original /model.`,
  )
  return lines.join('\n')
}
