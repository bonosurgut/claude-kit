import { test, expect } from 'claude-code/testing'
import { bar, contextTone, limitSegment, cacheSegment, costSegment, composeLine } from '../hooks/format'

test('bar: 0/50/62/100 percent', () => {
  expect(bar(0)).toBe('▫▫▫▫▫▫▫▫')
  expect(bar(50)).toBe('▪▪▪▪▫▫▫▫')
  expect(bar(62)).toBe('▪▪▪▪▪▫▫▫')
  expect(bar(100)).toBe('▪▪▪▪▪▪▪▪')
  expect(bar(140)).toBe('▪▪▪▪▪▪▪▪')
  expect(bar(-5)).toBe('▫▫▫▫▫▫▫▫')
})

test('contextTone: boundaries 49/50/59/60 with red=60', () => {
  expect(contextTone(49, 60)).toBe('normal')
  expect(contextTone(50, 60)).toBe('warn')
  expect(contextTone(59, 60)).toBe('warn')
  expect(contextTone(60, 60)).toBe('alert')
})

test('contextTone: boundaries 49/50 with red=50, the plugin default (no warn band below it)', () => {
  expect(contextTone(49, 50)).toBe('normal')
  expect(contextTone(50, 50)).toBe('alert')
})

test('contextTone: red below 50 has no warn band', () => {
  expect(contextTone(39, 40)).toBe('normal')
  expect(contextTone(40, 40)).toBe('alert')
})

test('limitSegment: five_hour, seven_day with reset, unknown kind hidden', () => {
  expect(limitSegment({ kind: 'five_hour', percentUsed: 14 })!.text).toBe('5ч ▪▫▫▫▫▫▫▫ 14%')
  // 2026-10-15 is a Thursday; local time 10:00
  const resetsAt = new Date(2026, 9, 15, 10, 0).toISOString()
  expect(limitSegment({ kind: 'seven_day', percentUsed: 48, resetsAt })!.text).toBe('нед ▪▪▪▪▫▫▫▫ 48% · сброс чт 10:00')
  expect(limitSegment({ kind: 'spend_limit', percentUsed: 5 })).toBe(null)
})

test('cacheSegment: none before first turn, minutes, cold at ttl', () => {
  const min = 60_000
  expect(cacheSegment(10 * min, 0, 5)).toBe(null)
  expect(cacheSegment(10 * min, 10 * min - 3 * min - 1000, 5)!.text).toBe('кэш ◷ 3м')
  expect(cacheSegment(10 * min, 10 * min - 4 * min - 59_000, 5)!.tone).toBe('normal')
  expect(cacheSegment(10 * min, 10 * min - 5 * min, 5)).toEqual({ text: 'кэш остыл', tone: 'dim' })
})

test('costSegment: two decimals, hidden when off or absent', () => {
  expect(costSegment(1.8449, true)!.text).toBe('$1.84')
  expect(costSegment(1.84, false)).toBe(null)
  expect(costSegment(null, true)).toBe(null)
})

test('composeLine: API-key session (no limits, no cost) draws only ctx + cache', () => {
  const segs = composeLine(
    { percent: 62, rateLimits: [], usd: null, now: 600_000, lastTurnAt: 420_000 },
    { redAt: 60, cacheMinutes: 5, showCost: true },
  )
  expect(segs.map(s => s.text)).toEqual(['▪▪▪▪▪▫▫▫ 62%', 'кэш ◷ 3м'])
  expect(segs[0]!.tone).toBe('alert')
})

test('composeLine: nothing known draws nothing', () => {
  expect(composeLine({ percent: null, rateLimits: [], usd: null, now: 0, lastTurnAt: 0 },
    { redAt: 60, cacheMinutes: 5, showCost: true })).toEqual([])
})
