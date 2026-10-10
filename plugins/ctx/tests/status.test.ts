import { test, expect, mock } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

// Откуда ожидаемые строки (независимо от кода плагина):
//  - спека F-03...F-06 дословно: `▪▪▪▪▪▫▫▫ 62%` (слова «ctx» в сегменте нет: имя плагина перед
//    статусом ставит сам Claude Code, см. F-07), `5ч ▪▫▫▫▫▫▫▫ 14%`,
//    `нед ▪▪▪▪▫▫▫▫ 48% · сброс чт 10:00`, `кэш ◷ 3м`, `кэш остыл`, `$1.84`; остальные шкалы
//    посчитаны руками: делений round(процент / 100 * 8) из 8 (10% -> 1, 39% и 40% -> 3, 49% и 50% -> 4, 59% и 60% -> 5, 62% -> 5, 95% -> 8);
//  - «🔴 » в начале строки и три пробела между сегментами в спеке дословно не записаны: F-07
//    называет только значок 🔴 и причину (свой ⚠ не отличить от ⚠ движка), а «🔴 » с пробелом
//    и три пробела — решения проекта (значок вместо цветов — проба S-0, docs/probe-s0.md;
//    красный круг вместо ⚠ — находка живой проверки Task 9 и указание оркестратора).
//    Эти две формулировки сверит ревью, тест их лишь фиксирует.
// Рисование проверяется по строке, которую получил $.ui.status: хук под плагином её перехватывает.

const T0 = 1_000_000
const MIN = 60_000
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const usageOf = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  startedAt: 0,
  context: { window: 200_000 },
  rateLimits: [],
  ...over,
})

// Мир под плагином: часы с замороженным временем, перехват $.ui.status, ответы на
// session.usage и «дно» для событий, которые плагин наблюдает (без дна вызов падает).
function world(on: On, usage: SessionUsage = usageOf()) {
  const clock = mock.clock(on, { now: T0 })
  const shown: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return { clock, shown, last: () => shown[shown.length - 1] }
}

const measureArg = (percent: number | undefined, rateLimits: SessionRateLimit[] = [], usd?: number) => ({
  context: percent === undefined ? { window: 200_000 } : { window: 200_000, percent },
  rateLimits,
  ...(usd === undefined ? {} : { cost: { usd } }),
  changed: ['context' as const],
})

const turnArg = (agentId?: string) => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

test('session.start draws the line from session.usage: ctx, 5h window, cost, joined by three spaces', async ($, on) => {
  const w = world(on, usageOf({
    context: { window: 200_000, percent: 62 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 14 }],
    cost: { usd: 1.84 },
  }))
  await $.session.start(START)
  expect(w.shown).toEqual(['🔴 ▪▪▪▪▪▫▫▫ 62%   5ч ▪▫▫▫▫▫▫▫ 14%   $1.84'])
})

test('session.measure: ctx only, no limits drawn (API key session)', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(62))
  expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%')
  expect(w.last()).not.toContain('5ч')
  expect(w.last()).not.toContain('нед')
  expect(w.last()).not.toContain('$')
})

test('session.measure: 5h window appears, then 7-day window with local reset time', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 14 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   5ч ▪▫▫▫▫▫▫▫ 14%')
  // 2026-10-15 is a Thursday, local 10:00
  const resetsAt = new Date(2026, 9, 15, 10, 0).toISOString()
  await $.session.measure(measureArg(10, [
    { kind: 'five_hour', percentUsed: 14 },
    { kind: 'seven_day', percentUsed: 48, resetsAt },
    { kind: 'spend_limit', percentUsed: 5 },
  ]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   5ч ▪▫▫▫▫▫▫▫ 14%   нед ▪▪▪▪▫▫▫▫ 48% · сброс чт 10:00')
})

test('7-day window without a reset time, or with one that is not a date, is drawn without the reset part', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 48 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   нед ▪▪▪▪▫▫▫▫ 48%')
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 48, resetsAt: 'not-a-date' }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   нед ▪▪▪▪▫▫▫▫ 48%')
})

// Умолчание redAt = 50 (решение пользователя перед публикацией: 🔴 вместе с вопросом handoff; жёлтой зоны нет).
test('alert mark (default redAt 50): percent 49 has none, 50 has it, 49.4 rounds down to 49 and 49.6 up to 50', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(49))
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%')
  expect(w.last()!.startsWith('🔴')).toBe(false)
  await $.session.measure(measureArg(50))
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%')
  await $.session.measure(measureArg(49.4))
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%')
  await $.session.measure(measureArg(49.6))
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%')
})

test('alert mark follows an explicit redAt of 60 (the old default): 59 quiet, 60 marked', { options: { redAt: 60 } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(59))
  expect(w.last()).toBe('▪▪▪▪▪▫▫▫ 59%')
  await $.session.measure(measureArg(60))
  expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 60%')
})

test('alert mark follows the redAt option: 39 quiet, 40 marked with redAt=40', { options: { redAt: 40 } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(39))
  expect(w.last()).toBe('▪▪▪▫▫▫▫▫ 39%')
  await $.session.measure(measureArg(40))
  expect(w.last()).toBe('🔴 ▪▪▪▫▫▫▫▫ 40%')
})

test('alert mark is for the ctx gauge only: a 95% limit alone or beside a quiet ctx adds no mark', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(undefined, [{ kind: 'five_hour', percentUsed: 95 }]))
  expect(w.last()).toBe('5ч ▪▪▪▪▪▪▪▪ 95%')
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 95 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   5ч ▪▪▪▪▪▪▪▪ 95%')
})

// Claude Code сам рисует статус плагина как `⚠ <имя плагина>: <текст>` (замечено вживую в 2.1.295),
// поэтому в наших строках не должно быть ни своего ⚠, ни слова «ctx» в начале (оно было бы дублем).
// Источник: находка живой проверки Task 9 (task-9-ctxfix-brief.md), не вывод плагина.
test('no drawn line contains ⚠ or starts with the word ctx: ctx percents from none to 100, limit, cache timer', async ($, on) => {
  const w = world(on)
  const percents = [undefined, 0, 10, 49, 50, 59, 60, 62, 90, 100]
  for (const p of percents) {
    await $.session.measure(measureArg(p, [{ kind: 'five_hour', percentUsed: 95 }], 1.5))
  }
  // 10 измерений на входе -> 10 нарисованных строк, и ни одна не пустая (лимит 95% есть всегда)
  expect(w.shown.length).toBe(percents.length)
  expect(w.shown.every(line => line !== undefined)).toBe(true)
  // не вхолостую: значок 🔴 стоит ровно на входах >= 50 (50, 59, 60, 62, 90, 100), по входу, а не по выводу
  expect(w.shown.filter(line => line!.startsWith('🔴 ')).length).toBe(percents.filter(p => p !== undefined && p >= 50).length)
  expect(percents.filter(p => p !== undefined && p >= 50).length).toBe(6)
  // таймер кэша: «кэш ◷ Nм» и «кэш остыл» тоже в проверяемых строках
  await $.turn.complete(turnArg())
  await w.clock.advance(5 * MIN)
  expect(w.last()).toContain('кэш остыл')
  const lines = w.shown.filter((line): line is string => line !== undefined)
  expect(lines.length).toBe(w.shown.length)
  expect(lines.filter(line => line.includes('⚠')).length).toBe(0)
  expect(lines.filter(line => line.startsWith('ctx ')).length).toBe(0)
  expect(lines.filter(line => line.includes('ctx')).length).toBe(0)
})

test('percent 0 is drawn; no percent at all draws no ctx gauge', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(0))
  expect(w.last()).toBe('▫▫▫▫▫▫▫▫ 0%')
  await $.session.measure(measureArg(undefined, [{ kind: 'five_hour', percentUsed: 14 }]))
  expect(w.last()).toBe('5ч ▪▫▫▫▫▫▫▫ 14%')
})

test('nothing known: the status line is cleared with undefined, once per draw', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.shown).toEqual([undefined])
  await $.session.measure(measureArg(undefined))
  expect(w.shown).toEqual([undefined, undefined])
})

test('a line that was drawn is cleared when the data goes away', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(62))
  expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%')
  await $.session.measure(measureArg(undefined))
  expect(w.shown.length).toBe(2)
  expect(w.last()).toBe(undefined)
})

test('cost: shown with two decimals by default', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 2))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   $2.00')
})

test('cost is hidden when showCost is off', { options: { showCost: false } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 2))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
  expect(w.last()).not.toContain('$2.00')
})

test('no cost in usage: no dollar segment even with showCost on', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
})

test('cache timer: not drawn before the first turn, counts minutes each tick, cold at exactly 5 min', async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%'])
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 0м')
  for (const minutes of [1, 2, 3, 4]) {
    await w.clock.advance(MIN)
    expect(w.last()).toBe(`▪▫▫▫▫▫▫▫ 10%   кэш ◷ ${minutes}м`)
  }
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш остыл')
})

test('cache timer: 4 min 59 s is still warm (measure redraws between ticks), 5 min 0 s is cold', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(5 * MIN - 1000)
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 4м')
  await w.clock.advance(1000)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш остыл')
})

test('cache timer follows the cacheMinutes option: cold at 2 min with cacheMinutes=2', { options: { cacheMinutes: 2 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(MIN)
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 1м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш остыл')
})

test('a subagent turn does not start the cache timer; the main turn does', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10))
  await $.turn.complete(turnArg('agent-1'))
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%'])
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 0м')
})

test('redraw once a minute: nothing at 59.999 s, exactly one draw at 60 s, one more at 120 s', async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  expect(w.shown.length).toBe(1)
  await w.clock.advance(MIN - 1)
  expect(w.shown.length).toBe(1)
  await w.clock.advance(1)
  expect(w.shown.length).toBe(2)
  await w.clock.advance(MIN)
  expect(w.shown.length).toBe(3)
})

test('a second session.start replaces the minute timer instead of stacking another', async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  await $.session.start(START)
  expect(w.shown.length).toBe(2)
  await w.clock.advance(MIN)
  expect(w.shown.length).toBe(3)
})

test('the plugin only observes: the answers of session.measure and turn.complete pass through unchanged', async ($, on) => {
  world(on)
  expect(await $.session.measure(measureArg(10))).toEqual({ changed: ['context'] })
  expect(await $.turn.complete(turnArg())).toEqual({ text: 'ok' })
  expect(await $.turn.complete(turnArg('agent-1'))).toEqual({ text: 'ok' })
})

// Таймер кэша привязан к концу хода, а не к старту сессии: ход кончается через 30 с после
// session.start, и минутные тики (и «кэш остыл») идут от конца хода.
test('cache timer is phased by the end of the turn: 4m59s after a turn started 30 s into the session is warm, 5m00s is cold', async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  await w.clock.advance(30_000)
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 0м')
  await w.clock.advance(5 * MIN - 1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 4м')
  // start + turn + ticks at turn+1, +2, +3, +4 minutes; the tick of the session start (at +60 s) is gone
  expect(w.shown.length).toBe(1 + 1 + 4)
  await w.clock.advance(1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш остыл')
})

test('cache goes cold exactly at a fractional cacheMinutes, between two minute ticks', { options: { cacheMinutes: 2.5 } }, async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(150_000 - 1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 2м')
  await w.clock.advance(1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш остыл')
})

test('repeated turns restart the timers instead of stacking them', async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(10_000)
  await $.turn.complete(turnArg())
  await w.clock.advance(10_000)
  await $.turn.complete(turnArg())
  // start + three turns
  expect(w.shown.length).toBe(4)
  // a single chain of ticks counted from the last turn: turn+1, +2, +3, +4 minutes
  await w.clock.advance(5 * MIN - 1)
  expect(w.shown.length).toBe(4 + 4)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш ◷ 4м')
  await w.clock.advance(1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%   кэш остыл')
})

// /clear внутри процесса приходит как session.end без последующего session.start (так сказано в типах движка);
// /resume ведёт себя в плагине так же: сбрасывается то же самое.
for (const reason of ['clear', 'resume'] as const) {
  test(`session.end ${reason}: the old line is cleared at once and the timer does not bring it back`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.session.measure(measureArg(62, [{ kind: 'five_hour', percentUsed: 14 }], 2))
    await $.turn.complete(turnArg())
    expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%   5ч ▪▫▫▫▫▫▫▫ 14%   кэш ◷ 0м   $2.00')
    const before = w.shown.length
    expect(await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
    expect(w.shown.length).toBe(before + 1)
    expect(w.last()).toBe(undefined)
    // the minute timer keeps running and draws an empty line, not the old one
    await w.clock.advance(MIN)
    expect(w.shown.length).toBe(before + 2)
    expect(w.last()).toBe(undefined)
    await w.clock.advance(10 * MIN)
    expect(w.shown.slice(before)).toEqual(Array(1 + 1 + 10).fill(undefined))
    // the new conversation draws from its own measurement: no old cache timer, no old cost
    await $.session.measure(measureArg(10))
    expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
  })
}

for (const reason of ['prompt_input_exit', 'logout', 'other'] as const) {
  test(`session.end ${reason}: the line is left as it was`, async ($, on) => {
    const w = world(on)
    await $.session.measure(measureArg(62))
    const before = w.shown.length
    expect(await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
    expect(w.shown.length).toBe(before)
    expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%')
  })
}

// Без options: плагин получает умолчания из plugin.json (redAt 50, cacheMinutes 5, showCost true).
test('manifest defaults with no options: mark at 50, cache cold at 5 min, cost shown', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await $.session.measure(measureArg(49, [], 3.456))
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%   кэш ◷ 0м   $3.46')
  await $.session.measure(measureArg(50, [], 3.456))
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%   кэш ◷ 0м   $3.46')
  await w.clock.advance(4 * MIN)
  expect(w.last()).toContain('кэш ◷ 4м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%   кэш остыл   $3.46')
})
