import { test, expect, mock } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

// Откуда ожидаемые строки (независимо от кода плагина):
//  - спека F-03...F-06 дословно: `▪▪▪▪▪▫▫▫ 62%` (слова «ctx» в сегменте нет: имя плагина перед
//    статусом ставит сам Claude Code, см. F-07), `5ч ▪▫▫▫▫▫▫▫ 14%`, `кэш остыл`, `$1.84`; остальные шкалы
//    посчитаны руками: делений round(процент / 100 * 8) из 8 (10% -> 1, 39% и 40% -> 3, 49% и 50% -> 4, 59% и 60% -> 5, 62% -> 5, 71% -> 6, 95% -> 8);
//  - вид строки с 0.3.0 — спека ctx 0.3.0 (.scratch/ctx-lang-compact/spec.md) и тикет 01: два пробела между
//    частями («Разделитель»), `↻` вместо «сброс» (`нед ▪▪▪▪▪▫▫▫ 61% ↻вс 10:00`), `кэш 0м` без `◷`, у 5-часового окна
//    остаток до сброса; полная строка и примеры округления (2 ч 13 мин 01 с -> `↻2ч14м`, 59 мин 30 с -> `↻1ч00м`,
//    ровно 45 мин -> `↻45м`, 30 с -> `↻1м`, ровно 5 ч -> `↻5ч00м`) взяты оттуда дословно, а остальные строки таблицы
//    REMAINING (границы остатка) посчитаны руками из правила «минуты вверх; остаток <= 0 -> без `↻`»;
//  - английские строки (F-27) — спека ctx 0.3.0 и тикет 02: строка `▪▪▪▪▫▫▫▫ 49%  5h ▪▪▪▪▪▪▫▫ 71% ↻2h14m  wk ▪▪▪▪▪▫▫▫ 61%
//    ↻Sun 10:00  cache 0m` дословно, слова словаря (`5h`, `wk`, `h`, `m`, `Sun`…`Sat`, `cache`, `cold`) из «Словаря», а
//    английские остатки до сброса — дословно в спеке только `↻2h14m`, остальные получены тем же правилом, что у русских, с
//    `h`/`m` вместо `ч`/`м` (отдельной английской таблицы в спеке нет: это проверит ревью); русскую часть спека не меняет, поэтому без опции `lang` все ожидания выше остались прежними;
//  - стоимость (F-29) — спека ctx 0.3.0, «Стоимость» и истории 26–30, тикет 03: с 0.3.0 `$1.84` из спеки F-06 рисуется
//    только при включённой настройке `showCost`, а без неё `$` в строке нет, даже если движок сумму дал (в спеке v1 F-06 стояло
//    «по умолчанию да», это развёрнуто); тесты, которые рисуют `$` попутно, подают `showCost: true` явной опцией;
//  - «🔴 » в начале строки в спеке дословно не записан: F-07 называет только значок 🔴 и причину (свой ⚠ не
//    отличить от ⚠ движка), а «🔴 » с пробелом — решение проекта (значок вместо цветов — проба S-0,
//    docs/probe-s0.md; красный круг вместо ⚠ — находка живой проверки Task 9 и указание оркестратора).
//    Эту формулировку сверит ревью, тест её лишь фиксирует.
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
function world(on: On, usage: SessionUsage = usageOf(), now: number = T0) {
  const clock = mock.clock(on, { now })
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

// Тикет 03 (F-29): тест про состав строки с стоимостью (`$1.84` последней частью), а не про умолчание, поэтому `showCost: true`
// подан явно: до 0.3.0 стоимость рисовалась по умолчанию, теперь по умолчанию её нет (умолчание проверяют тесты ниже).
test('session.start draws the line from session.usage: ctx, 5h window, cost, joined by two spaces', { options: { showCost: true } }, async ($, on) => {
  const w = world(on, usageOf({
    context: { window: 200_000, percent: 62 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 14 }],
    cost: { usd: 1.84 },
  }))
  await $.session.start(START)
  expect(w.shown).toEqual(['🔴 ▪▪▪▪▪▫▫▫ 62%  5ч ▪▫▫▫▫▫▫▫ 14%  $1.84'])
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
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▫▫▫▫▫▫▫ 14%')
  // 2026-10-15 is a Thursday, local 10:00
  const resetsAt = new Date(2026, 9, 15, 10, 0).toISOString()
  await $.session.measure(measureArg(10, [
    { kind: 'five_hour', percentUsed: 14 },
    { kind: 'seven_day', percentUsed: 48, resetsAt },
    { kind: 'spend_limit', percentUsed: 5 },
  ]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▫▫▫▫▫▫▫ 14%  нед ▪▪▪▪▫▫▫▫ 48% ↻чт 10:00')
})

test('7-day window without a reset time, or with one that is not a date, is drawn without the reset part', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 48 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  нед ▪▪▪▪▫▫▫▫ 48%')
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 48, resetsAt: 'not-a-date' }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  нед ▪▪▪▪▫▫▫▫ 48%')
})

// Спека ctx 0.3.0, «Часть недельного окна»: прошедшее время сброса у недельного окна не проверяется (как в 0.2.0).
// Часы здесь стоят на вторнике 2026-10-20 12:00 местного времени, а сброс — в воскресенье 2026-10-18 10:00, на двое суток и два часа раньше.
test('7-day window whose reset time has already passed still shows day and time (it is not checked, unlike the 5h window)', async ($, on) => {
  const w = world(on, usageOf(), new Date(2026, 9, 20, 12, 0).getTime())
  const resetsAt = new Date(2026, 9, 18, 10, 0).toISOString()
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 61, resetsAt }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  нед ▪▪▪▪▪▫▫▫ 61% ↻вс 10:00')
})

// --- F-28: плотная строка (спека ctx 0.3.0, тикет 01) ---

// Строка из спеки дословно (русский вариант): контекст 49%, 5 часов 71% с остатком 2 ч 14 мин, неделя 61% со сбросом в
// воскресенье 10:00, кэш 0 мин. Без стоимости: движок суммы не дал.
test('the full line from the spec: two-space separators, ↻ for both windows, remaining time on the 5h one, cache without ◷', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(49, [
    { kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 2 * 60 * MIN + 13 * MIN + 1000).toISOString() },
    // 2026-10-18 is a Sunday, local 10:00
    { kind: 'seven_day', percentUsed: 61, resetsAt: new Date(2026, 9, 18, 10, 0).toISOString() },
  ]))
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2ч14м  нед ▪▪▪▪▪▫▫▫ 61% ↻вс 10:00  кэш 0м')
})

// Остаток до сброса 5-часового окна, спека ctx 0.3.0, «Часть 5-часового окна»: примеры округления (первые пять строк
// таблицы) дословно; остальные — границы, посчитанные руками из правила «минуты вверх; >= 60 -> Xч и минуты двумя
// цифрами; остаток <= 0 -> без `↻`». Время сброса задано смещением от часов плагина в мс, поэтому ожидание не зависит
// от часового пояса. Каждая строка таблицы — свой тест с одним замером, на русском (без опции) и на английском (`lang = en`).
const REMAINING: [label: string, offset: number, ru: string, en: string][] = [
  ['2 h 13 min 01 s -> 2h14m', 133 * MIN + 1000, ' ↻2ч14м', ' ↻2h14m'],
  ['59 min 30 s -> 1h00m', 59 * MIN + 30_000, ' ↻1ч00м', ' ↻1h00m'],
  ['exactly 45 min -> 45m', 45 * MIN, ' ↻45м', ' ↻45m'],
  ['30 s -> 1m (not 0m)', 30_000, ' ↻1м', ' ↻1m'],
  ['exactly 5 h -> 5h00m', 300 * MIN, ' ↻5ч00м', ' ↻5h00m'],
  ['exactly 0 -> no part', 0, '', ''],
  ['1 ms -> 1m', 1, ' ↻1м', ' ↻1m'],
  ['exactly 1 min -> 1m', MIN, ' ↻1м', ' ↻1m'],
  ['1 min and 1 ms -> 2m', MIN + 1, ' ↻2м', ' ↻2m'],
  ['exactly 59 min -> 59m', 59 * MIN, ' ↻59м', ' ↻59m'],
  ['59 min and 1 ms -> 1h00m', 59 * MIN + 1, ' ↻1ч00м', ' ↻1h00m'],
  ['exactly 60 min -> 1h00m', 60 * MIN, ' ↻1ч00м', ' ↻1h00m'],
  ['2 h 05 min -> 2h05m (minutes are two digits)', 125 * MIN, ' ↻2ч05м', ' ↻2h05m'],
  ['more than 5 h has no upper bound: 6 h 07 min', 367 * MIN, ' ↻6ч07м', ' ↻6h07m'],
  ['1 ms in the past -> no part', -1, '', ''],
  ['a minute in the past -> no part', -MIN, '', ''],
  ['a day in the past -> no part', -24 * 60 * MIN, '', ''],
]
for (const [label, offset, ru] of REMAINING) {
  test(`5h window remaining time: ${label}`, async ($, on) => {
    const w = world(on)
    await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + offset).toISOString() }]))
    expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71%' + ru])
  })
}
// Те же семнадцать строк при `lang = en` (F-27): единицы `h` и `m`, правила округления и границы те же.
for (const [label, offset, , en] of REMAINING) {
  test(`5h window remaining time (en): ${label}`, { options: { lang: 'en' } }, async ($, on) => {
    const w = world(on)
    await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + offset).toISOString() }]))
    expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%  5h ▪▪▪▪▪▪▫▫ 71%' + en])
  })
}

// Таблица не должна тихо похудеть: пять примеров спеки и двенадцать границ, всего 17 строк, по тесту на каждую, на каждом языке.
test('5h window remaining time: the table holds the five spec examples and twelve edges, none lost', () => {
  expect(REMAINING.length).toBe(17)
  expect(REMAINING.slice(0, 5).map(row => row[2])).toEqual([' ↻2ч14м', ' ↻1ч00м', ' ↻45м', ' ↻1м', ' ↻5ч00м'])
  expect(REMAINING.slice(0, 5).map(row => row[3])).toEqual([' ↻2h14m', ' ↻1h00m', ' ↻45m', ' ↻1m', ' ↻5h00m'])
})

test('5h window without a reset time, or with one that is not a date, is drawn without the remaining time, the rest in place', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71%')
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71, resetsAt: 'not-a-date' }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71%')
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71, resetsAt: '' }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71%')
  expect(w.shown.length).toBe(3)
})

// Остаток убывает на минутном тике сам (спека: «строка уже перерисовывается раз в минуту»): новых замеров между тиками нет.
test('5h remaining time falls by itself on the minute tick: 2h14m, 2h13m, 2h12m', async ($, on) => {
  const w = world(on, usageOf({
    context: { window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 133 * MIN + 1000).toISOString() }],
  }))
  await $.session.start(START)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2ч14м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2ч13м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2ч12м')
  // старт + два тика
  expect(w.shown.length).toBe(3)
})

test('5h remaining time on the minute tick across the hour edge: 1h02m, 1h01m, 1h00m, 59m, 58m', async ($, on) => {
  const w = world(on, usageOf({
    context: { window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 62 * MIN).toISOString() }],
  }))
  await $.session.start(START)
  const tails = [' ↻1ч02м', ' ↻1ч01м', ' ↻1ч00м', ' ↻59м', ' ↻58м']
  for (const [i, tail] of tails.entries()) {
    if (i > 0) await w.clock.advance(MIN)
    expect(w.last(), `after ${i} min`).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71%' + tail)
  }
  expect(w.shown.length).toBe(tails.length)
})

test('5h remaining time on the minute tick at the end: 90 s shows 2m, then 30 s shows 1m, then the part is gone and the window stays', async ($, on) => {
  const w = world(on, usageOf({
    context: { window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 90_000).toISOString() }],
  }))
  await $.session.start(START)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻1м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71%')
  expect(w.shown.length).toBe(3)
})

// Остаток считается от часов плагина, а не от замера: тот же замер без нового session.measure, но с другим «сейчас».
test('5h remaining time is counted from the plugin clock at each redraw: a turn end 10 min later redraws it from the same measure', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 45 * MIN).toISOString() }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻45м')
  await w.clock.advance(10 * MIN)
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▫▫ 71% ↻35м  кэш 0м')
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
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5ч ▪▪▪▪▪▪▪▪ 95%')
})

// Claude Code сам рисует статус плагина как `⚠ <имя плагина>: <текст>` (замечено вживую в 2.1.295),
// поэтому в наших строках не должно быть ни своего ⚠, ни слова «ctx» в начале (оно было бы дублем).
// Источник: находка живой проверки Task 9 (task-9-ctxfix-brief.md), не вывод плагина.
// Тикет 03 (F-29): `showCost: true` подан явно, чтобы проверяемые строки по-прежнему включали стоимость (по умолчанию её
// теперь нет); ниже проверено по входу, что `$1.50` стоит в каждой нарисованной строке, то есть опция не вхолостую.
test('no drawn line contains ⚠ or starts with the word ctx: ctx percents from none to 100, limit, cache timer, cost', { options: { showCost: true } }, async ($, on) => {
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
  // таймер кэша: «кэш Nм» и «кэш остыл» тоже в проверяемых строках
  await $.turn.complete(turnArg())
  await w.clock.advance(5 * MIN)
  expect(w.last()).toContain('кэш остыл')
  const lines = w.shown.filter((line): line is string => line !== undefined)
  expect(lines.length).toBe(w.shown.length)
  expect(lines.filter(line => line.includes('⚠')).length).toBe(0)
  expect(lines.filter(line => line.startsWith('ctx ')).length).toBe(0)
  expect(lines.filter(line => line.includes('ctx')).length).toBe(0)
  // каждая из строк несёт стоимость: на входе у каждого замера usd 1.5, в строках она стоит как `$1.50`
  expect(lines.filter(line => line.includes('$1.50')).length).toBe(lines.length)
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

// --- F-29: стоимость по умолчанию выключена (спека ctx 0.3.0, «Стоимость», истории 26–30; тикет 03) ---

// Переделан в тикете 03: раньше назывался «cost: shown with two decimals by default» и ждал `$2.00` без опций. Умолчание
// теперь «нет» (спека: «Стоимость по умолчанию не показывается»), поэтому тест про вид стоимости подаёт `showCost: true` явно.
test('cost: with showCost on, shown with two decimals as the last part', { options: { showCost: true } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 2))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  $2.00')
})

// Тот же вид стоимости на примере спеки: `$75.74` последней частью, через два пробела, после кэша, на обоих языках.
for (const [lang, line] of [
  ['ru', '▪▪▪▪▫▫▫▫ 49%  5ч ▪▪▪▪▪▪▫▫ 71%  кэш 0м  $75.74'],
  ['en', '▪▪▪▪▫▫▫▫ 49%  5h ▪▪▪▪▪▪▫▫ 71%  cache 0m  $75.74'],
] as const) {
  test(`cost (${lang}): with showCost on, $75.74 stands last, after the cache part, two spaces apart`, { options: { showCost: true, lang } }, async ($, on) => {
    const w = world(on)
    await $.session.measure(measureArg(49, [{ kind: 'five_hour', percentUsed: 71 }], 75.74))
    await $.turn.complete(turnArg())
    expect(w.last()).toBe(line)
  })
}

// Тест умолчания из тикета 03: без опций движок сумму дал (usd 2), а в строке `$` нет. Строка сравнивается целиком, чтобы
// провал в виде `$2.00` где угодно в строке не прошёл. Ожидание — из спеки («по умолчанию не показывается»), а не из вывода.
test('cost is off by default: the engine gives the sum, the line has no dollar part at all', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 2))
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%'])
})

// Умолчание держится и на строке из всех частей (контекст, оба окна, кэш), и на английском: нет ни `$`, ни хвостового разделителя.
for (const [lang, line] of [
  ['ru', '▪▪▪▪▫▫▫▫ 49%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2ч14м  нед ▪▪▪▪▪▫▫▫ 61% ↻вс 10:00  кэш 0м'],
  ['en', '▪▪▪▪▫▫▫▫ 49%  5h ▪▪▪▪▪▪▫▫ 71% ↻2h14m  wk ▪▪▪▪▪▫▫▫ 61% ↻Sun 10:00  cache 0m'],
] as const) {
  test(`cost is off by default (${lang}): the full line with the cache part ends at the cache, the sum $75.74 given by the engine is not drawn`, { options: { lang } }, async ($, on) => {
    const w = world(on)
    await $.session.measure(measureArg(49, [
      { kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 133 * MIN + 1000).toISOString() },
      // 2026-10-18 is a Sunday, local 10:00
      { kind: 'seven_day', percentUsed: 61, resetsAt: new Date(2026, 9, 18, 10, 0).toISOString() },
    ], 75.74))
    await $.turn.complete(turnArg())
    expect(w.last()).toBe(line)
  })
}

test('cost is hidden when showCost is off', { options: { showCost: false } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 2))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
  expect(w.last()).not.toContain('$2.00')
})

// Тикет 03: тест без опций раньше опирался на умолчание «да»; при умолчании «нет» он зеленел бы пустым (`$` нет в любом
// случае), поэтому `showCost: true` подан явно: так проверяется именно «включена, но движок суммы не дал».
test('no cost in usage: no dollar segment even with showCost on', { options: { showCost: true } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
})

// Граница: нулевая сумма — это сумма, а не «не дал»; при включённой настройке рисуется `$0.00`.
test('cost 0 with showCost on is a sum, not a missing one: drawn as $0.00', { options: { showCost: true } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 0))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  $0.00')
})

test('cache timer: not drawn before the first turn, counts minutes each tick, cold at exactly 5 min', async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%'])
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 0м')
  for (const minutes of [1, 2, 3, 4]) {
    await w.clock.advance(MIN)
    expect(w.last()).toBe(`▪▫▫▫▫▫▫▫ 10%  кэш ${minutes}м`)
  }
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш остыл')
})

test('cache timer: 4 min 59 s is still warm (measure redraws between ticks), 5 min 0 s is cold', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(5 * MIN - 1000)
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 4м')
  await w.clock.advance(1000)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш остыл')
})

test('cache timer follows the cacheMinutes option: cold at 2 min with cacheMinutes=2', { options: { cacheMinutes: 2 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(MIN)
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 1м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш остыл')
})

test('a subagent turn does not start the cache timer; the main turn does', async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10))
  await $.turn.complete(turnArg('agent-1'))
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%'])
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 0м')
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
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 0м')
  await w.clock.advance(5 * MIN - 1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 4м')
  // start + turn + ticks at turn+1, +2, +3, +4 minutes; the tick of the session start (at +60 s) is gone
  expect(w.shown.length).toBe(1 + 1 + 4)
  await w.clock.advance(1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш остыл')
})

test('cache goes cold exactly at a fractional cacheMinutes, between two minute ticks', { options: { cacheMinutes: 2.5 } }, async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await w.clock.advance(150_000 - 1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 2м')
  await w.clock.advance(1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш остыл')
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
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш 4м')
  await w.clock.advance(1)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  кэш остыл')
})

// /clear внутри процесса приходит как session.end без последующего session.start (так сказано в типах движка);
// /resume ведёт себя в плагине так же: сбрасывается то же самое.
// Тикет 03 (F-29): `showCost: true` подан явно. Тест про сброс строки после /clear и /resume, а стоимость в нём — часть
// проверяемого («no old cost» ниже): при умолчании «нет» `$2.00` в старой строке не появилась бы, и проверка стала бы пустой.
for (const reason of ['clear', 'resume'] as const) {
  test(`session.end ${reason}: the old line is cleared at once and the timer does not bring it back`, { options: { showCost: true } }, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.session.measure(measureArg(62, [{ kind: 'five_hour', percentUsed: 14 }], 2))
    await $.turn.complete(turnArg())
    expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%  5ч ▪▫▫▫▫▫▫▫ 14%  кэш 0м  $2.00')
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

// Без options: плагин получает умолчания из plugin.json (redAt 50, cacheMinutes 5, showCost false, lang ru): строка
// русская, потому что умолчание языка — `ru` (F-27, история 2), а стоимость не рисуется, хотя движок её дал (usd 3.456,
// F-29, истории 26 и 27: «по умолчанию не показывается»). Изменено в тикете 03: раньше умолчание было «да» и тест ждал `$3.46`.
test('manifest defaults with no options: mark at 50, cache cold at 5 min, cost hidden', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(turnArg())
  await $.session.measure(measureArg(49, [], 3.456))
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%  кэш 0м')
  await $.session.measure(measureArg(50, [], 3.456))
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%  кэш 0м')
  await w.clock.advance(4 * MIN)
  expect(w.last()).toContain('кэш 4м')
  await w.clock.advance(MIN)
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%  кэш остыл')
})

// --- F-27: язык строк (спека ctx 0.3.0, тикет 02) ---
//
// Один шов, как выше: плагин против подменённого движка, настройка `lang` подаётся опцией теста. Строка, которую получил
// $.ui.status, когда сессию не видит одно приложение (в этом мире список поверхностей пуст), — строка состояния терминала
// (история 8); строка в полосе приложения — в band.test.ts. Русский вариант каждой строки уже закреплён тестами выше: они
// идут без опции `lang`, то есть проверяют и умолчание `ru`.

const EN = { options: { lang: 'en' } }

// Строка из спеки дословно, английский вариант; входы те же, что у русского теста «the full line from the spec» выше.
test('lang en: the full line from the spec in English: 5h and wk, h and m, Sun, cache, two-space separators', EN, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(49, [
    { kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 2 * 60 * MIN + 13 * MIN + 1000).toISOString() },
    // 2026-10-18 is a Sunday, local 10:00
    { kind: 'seven_day', percentUsed: 61, resetsAt: new Date(2026, 9, 18, 10, 0).toISOString() },
  ]))
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%  5h ▪▪▪▪▪▪▫▫ 71% ↻2h14m  wk ▪▪▪▪▪▫▫▫ 61% ↻Sun 10:00  cache 0m')
})

// Дни недели в обоих языках, все семь: 2026-10-18 воскресенье, 10-19 понедельник ... 10-24 суббота (местное время, 10:00).
// Слова — из спеки («Словарь»): `вс пн вт ср чт пт сб` / `Sun Mon Tue Wed Thu Fri Sat`. Воскресенье и суббота (`Sun` и
// `Sat`) приходятся на разные даты, 18 и 24 октября.
const WEEK: [day: number, ru: string, en: string][] = [
  [18, 'вс', 'Sun'],
  [19, 'пн', 'Mon'],
  [20, 'вт', 'Tue'],
  [21, 'ср', 'Wed'],
  [22, 'чт', 'Thu'],
  [23, 'пт', 'Fri'],
  [24, 'сб', 'Sat'],
]
for (const lang of ['ru', 'en'] as const) {
  test(`7-day reset weekday (${lang}): all seven days, from Sunday to Saturday, in the language of the setting`, { options: { lang } }, async ($, on) => {
    const w = world(on)
    for (const [day, ru, en] of WEEK) {
      await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 61, resetsAt: new Date(2026, 9, day, 10, 0).toISOString() }]))
      const label = lang === 'en' ? `wk` : 'нед'
      expect(w.last(), `2026-10-${day}`).toBe(`▪▫▫▫▫▫▫▫ 10%  ${label} ▪▪▪▪▪▫▫▫ 61% ↻${lang === 'en' ? en : ru} 10:00`)
    }
    // вход: семь замеров, семь нарисованных строк
    expect(w.shown.length).toBe(WEEK.length)
    expect(WEEK.length).toBe(7)
  })
}

test('lang en: the 7-day window without a reset time, or with one that is not a date, and the 5h window without one, keep their English labels', EN, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 48 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  wk ▪▪▪▪▫▫▫▫ 48%')
  await $.session.measure(measureArg(10, [{ kind: 'seven_day', percentUsed: 48, resetsAt: 'not-a-date' }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  wk ▪▪▪▪▫▫▫▫ 48%')
  await $.session.measure(measureArg(10, [{ kind: 'five_hour', percentUsed: 71 }]))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  5h ▪▪▪▪▪▪▫▫ 71%')
  expect(w.shown.length).toBe(3)
})

test('lang en: the remaining time falls on the minute tick by itself and crosses the hour edge: 1h02m, 1h01m, 1h00m, 59m, 58m', EN, async ($, on) => {
  const w = world(on, usageOf({
    context: { window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 62 * MIN).toISOString() }],
  }))
  await $.session.start(START)
  const tails = [' ↻1h02m', ' ↻1h01m', ' ↻1h00m', ' ↻59m', ' ↻58m']
  for (const [i, tail] of tails.entries()) {
    if (i > 0) await w.clock.advance(MIN)
    expect(w.last(), `after ${i} min`).toBe('▪▫▫▫▫▫▫▫ 10%  5h ▪▪▪▪▪▪▫▫ 71%' + tail)
  }
  expect(w.shown.length).toBe(tails.length)
})

test('lang en: cache 0m ... cache 4m, then cache cold at exactly 5 min', EN, async ($, on) => {
  const w = world(on, usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  cache 0m')
  for (const minutes of [1, 2, 3, 4]) {
    await w.clock.advance(MIN)
    expect(w.last()).toBe(`▪▫▫▫▫▫▫▫ 10%  cache ${minutes}m`)
  }
  await w.clock.advance(MIN)
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  cache cold')
})

test('lang en: the alert mark 🔴 stands on the threshold like in Russian: 49 quiet, 50 marked, 49.4 down, 49.6 up', EN, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(49))
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%')
  await $.session.measure(measureArg(50))
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%')
  await $.session.measure(measureArg(49.4))
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%')
  await $.session.measure(measureArg(49.6))
  expect(w.last()).toBe('🔴 ▪▪▪▪▫▫▫▫ 50%')
})

test('lang en does not change what carries no words: the cost $2.00 is the same, the 5h limit at 95% adds no mark', { options: { lang: 'en', showCost: true } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(10, [], 2))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%  $2.00')
  await $.session.measure(measureArg(undefined, [{ kind: 'five_hour', percentUsed: 95 }]))
  expect(w.last()).toBe('5h ▪▪▪▪▪▪▪▪ 95%')
})

// Вся строка на одном языке: при `en` ни одной русской буквы, при русском (умолчание) ни одной английской (истории 3 и 6:
// «в строке не оставалось русских слов»). Строки разной полноты: только контекст, потом оба окна с остатком и днём, стоимость,
// кэш тёплый и остывший. Число строк посчитано по входу: четыре замера, конец хода (1), минутные тики через 1...5 минут (5)
// и момент остывания кэша через 5 минут (1) = 11; окно 5 часов есть во всех, кроме первой.
// Сброс окна 5 часов — через 400 мин от часов плагина, к последней строке остаётся 395 мин = 6 ч 35 мин; недельный сброс — воскресенье 10:00.
const LANG_LINES = {
  ru: '🔴 ▪▪▪▪▪▫▫▫ 62%  5ч ▪▪▪▪▪▪▫▫ 71% ↻6ч35м  нед ▪▪▪▪▪▫▫▫ 61% ↻вс 10:00  кэш остыл  $1.84',
  en: '🔴 ▪▪▪▪▪▫▫▫ 62%  5h ▪▪▪▪▪▪▫▫ 71% ↻6h35m  wk ▪▪▪▪▪▫▫▫ 61% ↻Sun 10:00  cache cold  $1.84',
} as const
for (const lang of ['ru', 'en'] as const) {
  test(`lang ${lang}: every drawn line is in one language only, and the last one is the whole line`, { options: { lang, showCost: true } }, async ($, on) => {
    const w = world(on)
    const fiveHour = new Date(T0 + 400 * MIN).toISOString()
    // 2026-10-18 is a Sunday, local 10:00
    const sevenDay = new Date(2026, 9, 18, 10, 0).toISOString()
    await $.session.measure(measureArg(10))
    await $.session.measure(measureArg(62, [{ kind: 'five_hour', percentUsed: 71, resetsAt: fiveHour }]))
    await $.session.measure(measureArg(62, [
      { kind: 'five_hour', percentUsed: 71, resetsAt: fiveHour },
      { kind: 'seven_day', percentUsed: 61, resetsAt: sevenDay },
    ]))
    await $.session.measure(measureArg(62, [
      { kind: 'five_hour', percentUsed: 71, resetsAt: fiveHour },
      { kind: 'seven_day', percentUsed: 61, resetsAt: sevenDay },
    ], 1.84))
    await $.turn.complete(turnArg())
    await w.clock.advance(5 * MIN)
    expect(w.shown.length).toBe(4 + 1 + 5 + 1)
    const lines = w.shown.filter((line): line is string => line !== undefined)
    expect(lines.length).toBe(w.shown.length)
    const foreign = lang === 'en' ? /[А-Яа-яЁё]/ : /[A-Za-z]/
    expect(lines.filter(line => foreign.test(line)).length).toBe(0)
    // не вхолостую: окно 5 часов подписано на языке настройки в десяти строках из одиннадцати
    expect(lines.filter(line => line.includes(lang === 'en' ? '5h ' : '5ч ')).length).toBe(10)
    expect(w.last()).toBe(LANG_LINES[lang])
  })
}

// Значение `lang` вне списка (`de`): движок считает его незаданным и подставляет умолчание `ru` (справка по плагинам, про тест
// с `options`), так что через этот шов виден русский итог, но сам разбор значения в плагине он не проверяет: его проверяют
// прямые вызовы `wordsOf` и `composeLine` в format.test.ts (там `de` доходит до разбора как есть).
test('lang de (outside the list): the line is Russian', { options: { lang: 'de' } }, async ($, on) => {
  const w = world(on)
  await $.session.measure(measureArg(49, [
    { kind: 'five_hour', percentUsed: 71, resetsAt: new Date(T0 + 2 * 60 * MIN + 13 * MIN + 1000).toISOString() },
    { kind: 'seven_day', percentUsed: 61, resetsAt: new Date(2026, 9, 18, 10, 0).toISOString() },
  ]))
  await $.turn.complete(turnArg())
  expect(w.last()).toBe('▪▪▪▪▫▫▫▫ 49%  5ч ▪▪▪▪▪▪▫▫ 71% ↻2ч14м  нед ▪▪▪▪▪▫▫▫ 61% ↻вс 10:00  кэш 0м')
})
