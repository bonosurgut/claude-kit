import { test, expect } from 'claude-code/testing'
import { bar, contextTone, limitSegment, cacheSegment, costSegment, composeLine } from '../hooks/format'
import { EN, RU, wordsOf } from '../hooks/words'

// Мелкие тесты сборки строки получили словарь (F-27, спека ctx 0.3.0, «Словарь»): limitSegment и cacheSegment берут слова
// из него, composeLine — по опции `lang`. Русские ожидания остались прежними, английские написаны из спеки.

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
  const now = 1_000_000
  expect(limitSegment({ kind: 'five_hour', percentUsed: 14 }, now, RU)!.text).toBe('5ч ▪▫▫▫▫▫▫▫ 14%')
  // 2026-10-15 is a Thursday; local time 10:00
  const resetsAt = new Date(2026, 9, 15, 10, 0).toISOString()
  expect(limitSegment({ kind: 'seven_day', percentUsed: 48, resetsAt }, now, RU)!.text).toBe('нед ▪▪▪▪▫▫▫▫ 48% ↻чт 10:00')
  expect(limitSegment({ kind: 'spend_limit', percentUsed: 5 }, now, RU)).toBe(null)
})

test('limitSegment in English: wk and Thu, the unknown kind is hidden in both languages', () => {
  const now = 1_000_000
  expect(limitSegment({ kind: 'five_hour', percentUsed: 14 }, now, EN)!.text).toBe('5h ▪▫▫▫▫▫▫▫ 14%')
  const resetsAt = new Date(2026, 9, 15, 10, 0).toISOString()
  expect(limitSegment({ kind: 'seven_day', percentUsed: 48, resetsAt }, now, EN)!.text).toBe('wk ▪▪▪▪▫▫▫▫ 48% ↻Thu 10:00')
  expect(limitSegment({ kind: 'spend_limit', percentUsed: 5 }, now, EN)).toBe(null)
})

test('cacheSegment: none before first turn, minutes, cold at ttl', () => {
  const min = 60_000
  expect(cacheSegment(10 * min, 0, 5, RU)).toBe(null)
  expect(cacheSegment(10 * min, 10 * min - 3 * min - 1000, 5, RU)!.text).toBe('кэш 3м')
  expect(cacheSegment(10 * min, 10 * min - 4 * min - 59_000, 5, RU)!.tone).toBe('normal')
  expect(cacheSegment(10 * min, 10 * min - 5 * min, 5, RU)).toEqual({ text: 'кэш остыл', tone: 'dim' })
})

test('cacheSegment in English: none before first turn, cache 3m, cache cold at ttl', () => {
  const min = 60_000
  expect(cacheSegment(10 * min, 0, 5, EN)).toBe(null)
  expect(cacheSegment(10 * min, 10 * min - 3 * min - 1000, 5, EN)!.text).toBe('cache 3m')
  expect(cacheSegment(10 * min, 10 * min - 4 * min - 59_000, 5, EN)!.tone).toBe('normal')
  expect(cacheSegment(10 * min, 10 * min - 5 * min, 5, EN)).toEqual({ text: 'cache cold', tone: 'dim' })
})

test('costSegment: two decimals, hidden when off or absent', () => {
  expect(costSegment(1.8449, true)!.text).toBe('$1.84')
  expect(costSegment(1.84, false)).toBe(null)
  expect(costSegment(null, true)).toBe(null)
})

test('composeLine: API-key session (no limits, no cost) draws only ctx + cache', () => {
  const segs = composeLine(
    { percent: 62, rateLimits: [], usd: null, now: 600_000, lastTurnAt: 420_000 },
    { redAt: 60, cacheMinutes: 5, showCost: true, lang: 'ru' },
  )
  expect(segs.map(s => s.text)).toEqual(['▪▪▪▪▪▫▫▫ 62%', 'кэш 3м'])
  expect(segs[0]!.tone).toBe('alert')
})

test('composeLine: the same session in English draws only ctx + cache, in English', () => {
  const segs = composeLine(
    { percent: 62, rateLimits: [], usd: null, now: 600_000, lastTurnAt: 420_000 },
    { redAt: 60, cacheMinutes: 5, showCost: true, lang: 'en' },
  )
  expect(segs.map(s => s.text)).toEqual(['▪▪▪▪▪▫▫▫ 62%', 'cache 3m'])
  expect(segs[0]!.tone).toBe('alert')
})

test('composeLine: nothing known draws nothing', () => {
  expect(composeLine({ percent: null, rateLimits: [], usd: null, now: 0, lastTurnAt: 0 },
    { redAt: 60, cacheMinutes: 5, showCost: true, lang: 'ru' })).toEqual([])
})

// Страховка языка (спека ctx 0.3.0, «Настройка языка»): `en` -> английский, всё остальное -> русский. Здесь проверяется
// сам разбор значения: через тестовый движок значение вне списка `ru`/`en` до плагина не доходит (движок считает его
// незаданным и подставляет умолчание, справка по плагинам), поэтому «de» через шов страховку не проверяет, а прямой вызов проверяет.
test('wordsOf: only the exact value en gives English; ru, de, EN, an empty string, a missing value and a non-string give Russian', () => {
  expect(wordsOf('en')).toBe(EN)
  for (const other of ['ru', 'de', 'EN', 'en ', '', undefined, null, 5]) {
    expect(wordsOf(other), String(other)).toBe(RU)
  }
})

test('composeLine with a language outside the list draws Russian', () => {
  const input = {
    percent: 62,
    rateLimits: [{ kind: 'five_hour', percentUsed: 14 }],
    usd: null,
    now: 600_000,
    lastTurnAt: 420_000,
  }
  const line = (lang: string) => composeLine(input, { redAt: 60, cacheMinutes: 5, showCost: true, lang }).map(s => s.text)
  expect(line('de')).toEqual(['▪▪▪▪▪▫▫▫ 62%', '5ч ▪▫▫▫▫▫▫▫ 14%', 'кэш 3м'])
  expect(line('en')).toEqual(['▪▪▪▪▪▫▫▫ 62%', '5h ▪▫▫▫▫▫▫▫ 14%', 'cache 3m'])
})

// Словарь целиком. Ожидания — слова из тикета 02 и спеки ctx 0.3.0 («Словарь»), по одному на каждую запись; дни недели с
// воскресенья (так их отдаёт Date.getDay()). Счёт записей берётся по спеке: десять слов (5ч, нед, ч, м, кэш, остыл, агенты,
// работают, готово, сбой) и семь дней.
test('dictionary: every word of both languages is the one the spec lists, nothing missing and nothing extra', () => {
  expect(RU).toEqual({
    fiveHour: '5ч', sevenDay: 'нед', hour: 'ч', minute: 'м',
    days: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    cache: 'кэш', cold: 'остыл', agents: 'агенты', working: 'работают', done: 'готово', failed: 'сбой',
  })
  expect(EN).toEqual({
    fiveHour: '5h', sevenDay: 'wk', hour: 'h', minute: 'm',
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    cache: 'cache', cold: 'cold', agents: 'subagents', working: 'running', done: 'ready', failed: 'failed',
  })
  // десять слов (всё, кроме дней) и семь дней, в обоих языках
  for (const words of [RU, EN]) {
    expect(Object.keys(words).filter(key => key !== 'days').length).toBe(10)
    expect(words.days.length).toBe(7)
  }
})
