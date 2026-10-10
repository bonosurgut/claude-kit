import { test, expect } from 'claude-code/testing'
import * as L from '../hooks/logic'

// ---------- порог и «не сейчас» (F-15) ----------

// Умолчание порога — 50 (решение пользователя перед публикацией); два теста ниже берут 50 как базу, а большинство
// старых тестов дальше передают базу 60 явно (это явная настройка, а не умолчание).
test('threshold 49/50/51 (the default base)', () => {
  const t = L.initialTrigger(50)
  expect(L.measure(t, 49, 50).ask).toBe(false)
  expect(L.measure(t, 50, 50).ask).toBe(true)
  expect(L.measure(t, 51, 50).ask).toBe(true)
})

// Округление: процент сравнивается округлённым (Math.round), как в строке ctx и в тексте вопроса (решение
// пользователя: 🔴 и вопрос появляются вместе). Значения посчитаны руками: round(49.4)=49, round(49.5)=50,
// round(49.6)=50, round(59.4)=59, round(59.5)=60.
test('rounding, default base 50: 49.4 is quiet, 49.5 and 49.6 ask, 50 asks', () => {
  const t = L.initialTrigger(50)
  expect(L.measure(t, 49.4, 50).ask).toBe(false)
  expect(L.measure(t, 49.5, 50).ask).toBe(true)
  expect(L.measure(t, 49.6, 50).ask).toBe(true)
  expect(L.measure(t, 50, 50).ask).toBe(true)
})

test('rounding, explicit base 60: 59.4 is quiet, 59.5 asks', () => {
  const t = L.initialTrigger(60)
  expect(L.measure(t, 59.4, 60).ask).toBe(false)
  expect(L.measure(t, 59.5, 60).ask).toBe(true)
})

test('rounding applies to a snoozed threshold too: askAt 60 is quiet at 59.4 and asks at 59.5', () => {
  const t = L.snooze(50, 10)
  expect(t.askAt).toBe(60)
  expect(L.measure(t, 59.4, 50).ask).toBe(false)
  expect(L.measure(t, 59.5, 50).ask).toBe(true)
})

test('re-arm uses the same rounding: after a started handoff 49.5 and 49.6 (shown as 50%) do not re-arm, 49.4 does', () => {
  const t = L.startedTrigger(L.initialTrigger(50))
  for (const pct of [49.5, 49.6, 50]) {
    const r = L.measure(t, pct, 50)
    expect([pct, r.ask, r.next]).toEqual([pct, false, { askAt: 50, armed: false }])
  }
  const below = L.measure(t, 49.4, 50)
  expect(below.ask).toBe(false)
  expect(below.next).toEqual({ askAt: 50, armed: true })
})

test('no flapping on the boundary: 49.6, 49.4, 49.6 → ask, quiet (re-armed), ask again', () => {
  let t = L.initialTrigger(50)
  const first = L.measure(t, 49.6, 50)
  expect(first.ask).toBe(true)
  t = L.startedTrigger(first.next)
  const mid = L.measure(t, 49.4, 50)
  expect(mid.ask).toBe(false)
  expect(mid.next.armed).toBe(true)
  expect(L.measure(mid.next, 49.6, 50).ask).toBe(true)
})

test('snooze starts from the rounded percent: 49.4 → 59, 49.6 → 60', () => {
  expect(L.snooze(49.4, 10).askAt).toBe(59)
  expect(L.snooze(49.6, 10).askAt).toBe(60)
})

test('default cycle from 50: «Не сейчас» twice → 60 → 70 (59 and 69 silent)', () => {
  let t = L.snooze(50, 10)
  expect(t).toEqual({ askAt: 60, armed: true })
  expect(L.measure(t, 59, 50).ask).toBe(false)
  expect(L.measure(t, 60, 50).ask).toBe(true)
  t = L.snooze(60, 10)
  expect(L.measure(t, 69, 50).ask).toBe(false)
  expect(L.measure(t, 70, 50).ask).toBe(true)
})

test('threshold 59/60/61 with an explicit base of 60', () => {
  const t = L.initialTrigger(60)
  expect(L.measure(t, 59, 60).ask).toBe(false)
  expect(L.measure(t, 60, 60).ask).toBe(true)
  expect(L.measure(t, 61, 60).ask).toBe(true)
})

test('initialTrigger is armed at base, whatever the base', () => {
  expect(L.initialTrigger(60)).toEqual({ askAt: 60, armed: true })
  expect(L.initialTrigger(1)).toEqual({ askAt: 1, armed: true })
  expect(L.initialTrigger(100)).toEqual({ askAt: 100, armed: true })
})

test('snooze twice: 60 → 70 → 80', () => {
  let t = L.snooze(60, 10)
  expect(t).toEqual({ askAt: 70, armed: true })
  expect(L.measure(t, 69, 60).ask).toBe(false)
  expect(L.measure(t, 70, 60).ask).toBe(true)
  t = L.snooze(70, 10)
  expect(t.askAt).toBe(80)
})

test('jump over threshold snoozes from current value', () => {
  expect(L.measure(L.initialTrigger(60), 83, 60).ask).toBe(true)
  expect(L.snooze(83, 10).askAt).toBe(93)
})

test('snooze rounds a fractional percent to the nearest whole number', () => {
  expect(L.snooze(83.4, 10).askAt).toBe(93)
  expect(L.snooze(83.6, 10).askAt).toBe(94)
})

test('measure: asking does not consume the trigger, a snoozed trigger holds until its own threshold', () => {
  const t = L.snooze(60, 10)
  // между базой (60) и новым порогом (70) — тихо, состояние то же самое
  const quiet = L.measure(t, 65, 60)
  expect(quiet.ask).toBe(false)
  expect(quiet.next).toEqual({ askAt: 70, armed: true })
  // на пороге — вопрос, а возвращённое состояние остаётся тем же
  const loud = L.measure(t, 70, 60)
  expect(loud.ask).toBe(true)
  expect(loud.next).toEqual({ askAt: 70, armed: true })
})

test('after start: no ask until context drops below base, then re-armed at base', () => {
  const t = L.startedTrigger(L.initialTrigger(60))
  expect(L.measure(t, 90, 60).ask).toBe(false)
  const r = L.measure(t, 12, 60)
  expect(r.ask).toBe(false)
  expect(r.next).toEqual({ askAt: 60, armed: true })
  expect(L.measure(r.next, 60, 60).ask).toBe(true)
})

test('after start: base itself keeps it disarmed, base-1 re-arms (boundary 59/60)', () => {
  const t = L.startedTrigger(L.initialTrigger(60))
  const atBase = L.measure(t, 60, 60)
  expect(atBase.ask).toBe(false)
  expect(atBase.next).toEqual({ askAt: 60, armed: false })
  const below = L.measure(t, 59, 60)
  expect(below.ask).toBe(false)
  expect(below.next).toEqual({ askAt: 60, armed: true })
})

test('drop below base also forgets a snooze: threshold goes back from 70 to 60', () => {
  const r = L.measure(L.snooze(60, 10), 40, 60)
  expect(r.ask).toBe(false)
  expect(r.next).toEqual({ askAt: 60, armed: true })
})

test('startedTrigger keeps askAt, disarms, and does not touch its input', () => {
  const t = { askAt: 70, armed: true }
  expect(L.startedTrigger(t)).toEqual({ askAt: 70, armed: false })
  expect(t).toEqual({ askAt: 70, armed: true })
})

test('whole cycle: ask at 60, "not now" → 70, handoff started → silence → drop → ask at 60 again', () => {
  let t = L.initialTrigger(60)
  expect(L.measure(t, 60, 60).ask).toBe(true)
  t = L.snooze(60, 10)
  expect(L.measure(t, 69, 60).ask).toBe(false)
  expect(L.measure(t, 70, 60).ask).toBe(true)
  t = L.startedTrigger(t)
  expect(L.measure(t, 75, 60).ask).toBe(false)
  expect(L.measure(t, 95, 60).ask).toBe(false)
  t = L.measure(t, 8, 60).next
  expect(L.measure(t, 59, 60).ask).toBe(false)
  expect(L.measure(t, 60, 60).ask).toBe(true)
})

// ---------- настройки: границы (перенос из ревью Task 2) ----------

test('clampOptions: in-range values pass unchanged (60/10, step 1, threshold 100)', () => {
  expect(L.clampOptions({ threshold: 60, step: 10 })).toEqual({ threshold: 60, step: 10 })
  expect(L.clampOptions({ threshold: 1, step: 1 })).toEqual({ threshold: 1, step: 1 })
  expect(L.clampOptions({ threshold: 100, step: 25 })).toEqual({ threshold: 100, step: 25 })
})

test('clampOptions: step below 1 becomes 1 (0, -5, 0.4)', () => {
  expect(L.clampOptions({ threshold: 60, step: 0 }).step).toBe(1)
  expect(L.clampOptions({ threshold: 60, step: -5 }).step).toBe(1)
  expect(L.clampOptions({ threshold: 60, step: 0.4 }).step).toBe(1)
})

test('clampOptions: step is a whole number (2.4 → 2, 2.6 → 3)', () => {
  expect(L.clampOptions({ threshold: 60, step: 2.4 }).step).toBe(2)
  expect(L.clampOptions({ threshold: 60, step: 2.6 }).step).toBe(3)
})

test('clampOptions: threshold is held to 1..100 (0 → 1, -3 → 1, 150 → 100, 101 → 100)', () => {
  expect(L.clampOptions({ threshold: 0, step: 10 }).threshold).toBe(1)
  expect(L.clampOptions({ threshold: -3, step: 10 }).threshold).toBe(1)
  expect(L.clampOptions({ threshold: 150, step: 10 }).threshold).toBe(100)
  expect(L.clampOptions({ threshold: 101, step: 10 }).threshold).toBe(100)
})

test('clampOptions: not a usable number falls back to the defaults 50 / 10', () => {
  expect(L.clampOptions({})).toEqual({ threshold: 50, step: 10 })
  expect(L.clampOptions({ threshold: undefined, step: undefined })).toEqual({ threshold: 50, step: 10 })
  expect(L.clampOptions({ threshold: NaN, step: NaN })).toEqual({ threshold: 50, step: 10 })
  expect(L.clampOptions({ threshold: Infinity, step: Infinity })).toEqual({ threshold: 50, step: 10 })
  expect(L.clampOptions({ threshold: -Infinity, step: -Infinity })).toEqual({ threshold: 50, step: 10 })
  expect(L.clampOptions({ threshold: '70', step: '5' })).toEqual({ threshold: 50, step: 10 })
  expect(L.clampOptions({ threshold: null, step: true })).toEqual({ threshold: 50, step: 10 })
})

test('clampOptions: each field falls back on its own', () => {
  expect(L.clampOptions({ threshold: 75 })).toEqual({ threshold: 75, step: 10 })
  expect(L.clampOptions({ step: 20 })).toEqual({ threshold: 50, step: 20 })
})

test('clamped step always moves the trigger forward: snooze(60, clamp(0)) asks later than 60', () => {
  const { step } = L.clampOptions({ threshold: 60, step: 0 })
  expect(L.snooze(60, step).askAt).toBe(61)
  expect(L.measure(L.snooze(60, step), 60, 60).ask).toBe(false)
})

// ---------- папка хендофф-файлов (F-10, F-17) ----------

const has = (...xs: string[]) => (p: string) => xs.includes(p)

test('pickHandoffDir order and defaults', () => {
  expect(L.pickHandoffDir('/r', has('/r/plans/handoffs', '/r/.claude/handoffs'), true)).toBe('/r/plans/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers'), true)).toBe('/r/docs/superpowers/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/handoffs', '/r/.claude/handoffs'), true)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/.claude/handoffs'), true)).toBe('/r/.claude/handoffs')
  expect(L.pickHandoffDir('/r', has(), true)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/plans/handoffs'), false)).toBe('/r/docs/handoffs')
})

test('pickHandoffDir: each existing candidate alone, first in the list wins', () => {
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers/handoffs'), true)).toBe('/r/docs/superpowers/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/plans/handoffs'), true)).toBe('/r/plans/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/handoffs'), true)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/.claude/handoffs'), true)).toBe('/r/.claude/handoffs')
  expect(
    L.pickHandoffDir('/r', has('/r/.claude/handoffs', '/r/docs/handoffs', '/r/plans/handoffs', '/r/docs/superpowers/handoffs'), true),
  ).toBe('/r/docs/superpowers/handoffs')
})

test('pickHandoffDir: an existing candidate beats the docs/superpowers default', () => {
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers', '/r/docs/handoffs'), true)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers', '/r/.claude/handoffs'), true)).toBe('/r/.claude/handoffs')
})

test('pickHandoffDir: without git it is <root>/docs/handoffs, even if other folders exist', () => {
  expect(L.pickHandoffDir('/r', has(), false)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers'), false)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers/handoffs', '/r/.claude/handoffs'), false)).toBe('/r/docs/handoffs')
})

test('pickHandoffDir: all 32 combinations of existing folders agree with gather.py pick_handoff_dir', () => {
  // Эталон — не logic.ts, а skills/handoff/scripts/gather.py::pick_handoff_dir: таблица снята его прогоном
  // на настоящих временных папках (все 2^5 сочетаний). Буквы: S = docs/superpowers/handoffs, P = plans/handoffs,
  // D = docs/handoffs, C = .claude/handoffs, X = docs/superpowers (сама папка).
  const path: Record<string, string> = {
    S: 'docs/superpowers/handoffs',
    P: 'plans/handoffs',
    D: 'docs/handoffs',
    C: '.claude/handoffs',
    X: 'docs/superpowers',
  }
  const table: [string, string][] = [
    ['-', 'docs/handoffs'],
    ['S', 'docs/superpowers/handoffs'],
    ['P', 'plans/handoffs'],
    ['SP', 'docs/superpowers/handoffs'],
    ['D', 'docs/handoffs'],
    ['SD', 'docs/superpowers/handoffs'],
    ['PD', 'plans/handoffs'],
    ['SPD', 'docs/superpowers/handoffs'],
    ['C', '.claude/handoffs'],
    ['SC', 'docs/superpowers/handoffs'],
    ['PC', 'plans/handoffs'],
    ['SPC', 'docs/superpowers/handoffs'],
    ['DC', 'docs/handoffs'],
    ['SDC', 'docs/superpowers/handoffs'],
    ['PDC', 'plans/handoffs'],
    ['SPDC', 'docs/superpowers/handoffs'],
    ['X', 'docs/superpowers/handoffs'],
    ['SX', 'docs/superpowers/handoffs'],
    ['PX', 'plans/handoffs'],
    ['SPX', 'docs/superpowers/handoffs'],
    ['DX', 'docs/handoffs'],
    ['SDX', 'docs/superpowers/handoffs'],
    ['PDX', 'plans/handoffs'],
    ['SPDX', 'docs/superpowers/handoffs'],
    ['CX', '.claude/handoffs'],
    ['SCX', 'docs/superpowers/handoffs'],
    ['PCX', 'plans/handoffs'],
    ['SPCX', 'docs/superpowers/handoffs'],
    ['DCX', 'docs/handoffs'],
    ['SDCX', 'docs/superpowers/handoffs'],
    ['PDCX', 'plans/handoffs'],
    ['SPDCX', 'docs/superpowers/handoffs'],
  ]
  expect(table.length).toBe(32)
  expect(new Set(table.map(([k]) => k)).size).toBe(32)
  for (const [letters, expected] of table) {
    const present = letters === '-' ? [] : [...letters].map(c => `/r/${path[c]}`)
    expect([letters, L.pickHandoffDir('/r', has(...present), true)]).toEqual([letters, `/r/${expected}`])
    expect([letters, L.pickHandoffDir('/r', has(...present), false)]).toEqual([letters, '/r/docs/handoffs'])
  }
})

// ---------- путь авто-хендоффа (F-17) ----------

test('autoPath stamp is local time', () => {
  const ms = new Date(2026, 9, 8, 9, 5, 7).getTime()
  expect(L.autoPath('/r/.claude/handoffs', ms)).toBe('/r/.claude/handoffs/HANDOFF_auto_2026-10-08-090507.md')
})

test('stamp: zero padding, midnight, last second of the year', () => {
  expect(L.stamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02-030405')
  expect(L.stamp(new Date(2026, 5, 15, 0, 0, 0).getTime())).toBe('2026-06-15-000000')
  expect(L.stamp(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe('2026-12-31-235959')
})

test('autoPath: dir is used as given, the stamp differs second by second', () => {
  const a = new Date(2026, 9, 8, 9, 5, 7).getTime()
  expect(L.autoPath('/r/docs/handoffs', a)).toBe('/r/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md')
  expect(L.autoPath('/r/docs/handoffs', a + 1000)).toBe('/r/docs/handoffs/HANDOFF_auto_2026-10-08-090508.md')
})

// ---------- шапка цепочки и фраза для новой сессии (F-14) ----------

test('parseChain', () => {
  expect(L.parseChain('# x\n**Chain:** `standalone-ab12cd34` seq `3`\n')).toEqual({ tag: 'standalone-ab12cd34', seq: 3 })
  expect(L.parseChain('no header')).toBe(null)
})

test('parseChain: the template line of SKILL.md, multi-digit seq, header below other lines', () => {
  const text = [
    '# Итог сессии',
    '',
    '**Date:** 2026-10-09',
    '**Status:** IN PROGRESS',
    '**Chain:** `feat-v1` seq `12`',
    '**Parent:** `HANDOFF_feat-v1_x_2026-10-08.md`',
  ].join('\n')
  expect(L.parseChain(text)).toEqual({ tag: 'feat-v1', seq: 12 })
})

test('parseChain: the first Chain line wins when a later line quotes another one', () => {
  const text = '**Chain:** `new-tag` seq `5`\n\nПредыдущий: **Chain:** `old-tag` seq `4`\n'
  expect(L.parseChain(text)).toEqual({ tag: 'new-tag', seq: 5 })
})

test('parseChain: not a header means null (commit-message line, empty tag, missing or non-numeric seq, empty text)', () => {
  expect(L.parseChain('Chain: feat-v1 seq 1')).toBe(null)
  expect(L.parseChain('**Chain:** `` seq `3`')).toBe(null)
  expect(L.parseChain('**Chain:** `feat-v1`')).toBe(null)
  expect(L.parseChain('**Chain:** `feat-v1` seq `x`')).toBe(null)
  expect(L.parseChain('')).toBe(null)
})

test('parseChain: seq 0 is a number, not a missing header', () => {
  expect(L.parseChain('**Chain:** `t` seq `0`')).toEqual({ tag: 't', seq: 0 })
})

test('pastePrompt with and without chain', () => {
  const p = L.pastePrompt('/r/H.md', { tag: 't', seq: 2 })
  expect(p.split('\n')[0]).toBe('Прочитай `/r/H.md` (seq 2, t) и продолжи работу с раздела «Where We\'re Going».')
  expect(p.endsWith('Потом жди моего «поехали».')).toBe(true)
  expect(L.pastePrompt('/r/H.md', null).split('\n')[0]).toBe('Прочитай `/r/H.md` и продолжи работу с раздела «Where We\'re Going».')
})

test('pastePrompt: whole text, with the chain and without', () => {
  // Дословный текст — из плана (Task 7, Step 1/3). Спека F-14 даёт только смысл (перескажи в 5–8 строках
  // цель, состояние, что пробовали и не вышло; прочитай только файлы из Must-read; скажи, что проверишь
  // первым; затем жди «поехали») и дословной формулировки не содержит, так что точные слова держит план.
  const tail = [
    '',
    'Прежде чем начинать:',
    '1. Перескажи в 5–8 строках: цель, текущее состояние, что пробовали и что не вышло',
    '2. Прочитай ТОЛЬКО файлы из «Must-read» в Quick Start',
    '3. Скажи, что проверишь первым и каким будет первый шаг',
    'Потом жди моего «поехали».',
  ]
  expect(L.pastePrompt('/r/H.md', { tag: 'feat-v1', seq: 7 })).toBe(
    ['Прочитай `/r/H.md` (seq 7, feat-v1) и продолжи работу с раздела «Where We\'re Going».', ...tail].join('\n'),
  )
  expect(L.pastePrompt('/r/H.md', null)).toBe(
    ['Прочитай `/r/H.md` и продолжи работу с раздела «Where We\'re Going».', ...tail].join('\n'),
  )
})

test('pastePrompt: seq 0 still shows the chain reference', () => {
  expect(L.pastePrompt('/r/H.md', { tag: 't', seq: 0 }).split('\n')[0]).toBe(
    'Прочитай `/r/H.md` (seq 0, t) и продолжи работу с раздела «Where We\'re Going».',
  )
})

// ---------- команды запуска (F-18…F-21) ----------

test('shq and macCommandScript survive quotes, spaces, Cyrillic', () => {
  expect(L.shq("it's")).toBe(`'it'\\''s'`)
  const s = L.macCommandScript('/Users/Иван/Мои проекты/сайт', '/usr/local/bin/claude', "Прочитай `x` и 'жди'")
  expect(s).toBe(`#!/bin/zsh\ncd '/Users/Иван/Мои проекты/сайт' || exit 1\nexec '/usr/local/bin/claude' 'Прочитай \`x\` и '\\''жди'\\'''\n`)
})

test('shq: empty, plain, only a quote, several quotes, shell metacharacters and newlines stay literal', () => {
  expect(L.shq('')).toBe(`''`)
  expect(L.shq('abc')).toBe(`'abc'`)
  expect(L.shq("'")).toBe(`''\\'''`)
  expect(L.shq("a'b'c")).toBe(`'a'\\''b'\\''c'`)
  expect(L.shq('$HOME `x` "y" \\ !')).toBe(`'$HOME \`x\` "y" \\ !'`)
  expect(L.shq('a\nb')).toBe(`'a\nb'`)
})

test('macCommandScript: a root with an apostrophe and a multi-line prompt', () => {
  const s = L.macCommandScript("/Users/o'brien/proj", 'claude', 'line1\nline2')
  expect(s).toBe(`#!/bin/zsh\ncd '/Users/o'\\''brien/proj' || exit 1\nexec 'claude' 'line1\nline2'\n`)
})

test('windowsPrompt and windowsArgv', () => {
  expect(L.windowsPrompt('a\nb "c" & d | e')).toBe('a b c  d  e')
  expect(L.windowsArgv(true, 'C:\\Проекты\\сайт', 'claude', 'p')).toEqual(['wt', '-d', 'C:\\Проекты\\сайт', 'claude', 'p'])
  expect(L.windowsArgv(false, 'C:\\Проекты\\сайт', 'claude', 'p')).toEqual(['cmd', '/c', 'start', '', '/D', 'C:\\Проекты\\сайт', 'claude', 'p'])
})

test('windowsPrompt: every character of the set "&|<>^% is removed, CRLF and blank lines become one space', () => {
  expect(L.windowsPrompt('a"b&c|d<e>f^g%h')).toBe('abcdefgh')
  expect(L.windowsPrompt('a\r\nb')).toBe('a b')
  expect(L.windowsPrompt('a\n\n\nb')).toBe('a b')
  expect(L.windowsPrompt('')).toBe('')
  expect(L.windowsPrompt('Прочитай `x` и «жди»')).toBe('Прочитай `x` и «жди»')
})

test('windowsPrompt of the real phrase is one line without cmd metacharacters', () => {
  const out = L.windowsPrompt(L.pastePrompt('C:\\Проекты\\сайт\\H.md', { tag: 'feat-v1', seq: 3 }))
  expect(out.includes('\n')).toBe(false)
  expect(out.includes('\r')).toBe(false)
  for (const bad of ['"', '&', '|', '<', '>', '^', '%']) expect(out.includes(bad)).toBe(false)
  expect(out.startsWith('Прочитай `C:\\Проекты\\сайт\\H.md` (seq 3, feat-v1) и продолжи работу')).toBe(true)
  expect(out.endsWith('Потом жди моего «поехали».')).toBe(true)
})

test('windowsArgv: a root with spaces stays one argument in both branches', () => {
  expect(L.windowsArgv(true, 'C:\\Мои проекты\\сайт', 'claude', 'a b')).toEqual(['wt', '-d', 'C:\\Мои проекты\\сайт', 'claude', 'a b'])
  expect(L.windowsArgv(false, 'C:\\Мои проекты\\сайт', 'claude', 'a b')).toEqual(['cmd', '/c', 'start', '', '/D', 'C:\\Мои проекты\\сайт', 'claude', 'a b'])
})

test('windowsArgv: a claude path with a space and Cyrillic is one element; no wt means no nested cmd /k (F-19)', () => {
  const bin = 'C:\\Users\\Иван Петров\\.local\\bin\\claude.exe'
  const root = 'C:\\Мои проекты\\сайт'
  expect(L.windowsArgv(false, root, bin, 'a b')).toEqual(['cmd', '/c', 'start', '', '/D', root, bin, 'a b'])
  expect(L.windowsArgv(true, root, bin, 'a b')).toEqual(['wt', '-d', root, bin, 'a b'])
  // F-19: после '/D', корня идут сразу путь к claude и фраза; 'cmd' в массиве один (внешний), '/k' нет
  const argv = L.windowsArgv(false, root, bin, 'a b')
  expect(argv.slice(argv.indexOf('/D') + 2)).toEqual([bin, 'a b'])
  expect(argv.filter(a => a === 'cmd')).toEqual(['cmd'])
  expect(argv.includes('/k')).toBe(false)
})

test('windowsPathSafe: plain Windows-style and Cyrillic paths are safe, empty is safe', () => {
  expect(L.windowsPathSafe('C:/Проекты/сайт/docs/handoffs/HANDOFF_auto_x.md')).toBe(true)
  expect(L.windowsPathSafe('C:\\Мои проекты\\сайт\\H.md')).toBe(true)
  expect(L.windowsPathSafe('')).toBe(true)
})

test('windowsPathSafe: each of " & | < > ^ % and a line break makes the path unsafe', () => {
  expect(L.windowsPathSafe('C:/R&D/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a%b/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a^b/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a|b/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a<b/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a>b/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a"b/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a\nb/x.md')).toBe(false)
  expect(L.windowsPathSafe('C:/a\rb/x.md')).toBe(false)
})

test('windowsPathSafe agrees with windowsPrompt: a safe path survives it unchanged, an unsafe one does not', () => {
  const safe = 'C:/Проекты/сайт/H.md'
  const unsafe = 'C:/R&D/H.md'
  expect(L.windowsPathSafe(safe)).toBe(true)
  expect(L.windowsPrompt(safe)).toBe(safe)
  expect(L.windowsPathSafe(unsafe)).toBe(false)
  expect(L.windowsPrompt(unsafe)).toBe('C:/RD/H.md')
})

test('windowsPrompt: ";" becomes "," (Windows Terminal reads ";" as a command separator, ruling of Task 7 re-review)', () => {
  expect(L.windowsPrompt('a; b')).toBe('a, b')
  expect(L.windowsPrompt('a;b;;c')).toBe('a,b,,c')
  expect(L.windowsPrompt(';')).toBe(',')
  expect(L.windowsPrompt('a\nb; c "d"')).toBe('a b, c d')
})

test('windowsPrompt of the whole F-14 phrase has no ";", even when the chain tag or the path carry one', () => {
  for (const chain of [null, { tag: 'feat-v1', seq: 3 }, { tag: 'a;b', seq: 1 }]) {
    for (const path of ['C:/proj/docs/handoffs/H.md', 'C:/p;q/H.md']) {
      expect(L.windowsPrompt(L.pastePrompt(path, chain)).includes(';')).toBe(false)
    }
  }
})

test('windowsPathSafe: a path with ";" is unsafe, and the check agrees with windowsPrompt on it', () => {
  expect(L.windowsPathSafe('C:/a;b/x.md')).toBe(false)
  expect(L.windowsPathSafe(';')).toBe(false)
  expect(L.windowsPrompt('C:/a;b/x.md')).toBe('C:/a,b/x.md')
  expect(L.windowsPathSafe('C:/a,b/x.md')).toBe(true)
  expect(L.windowsPrompt('C:/a,b/x.md')).toBe('C:/a,b/x.md')
})

// Папки, существование которых мод проверяет перед выбором пути: четыре кандидата F-10 в порядке
// приоритета и `docs/superpowers` (признак «умолчание — docs/superpowers/handoffs»). Список записан
// по спеке F-10, а не списан с logic.ts.
test('HANDOFF_PROBES is the four F-10 candidates in priority order, then docs/superpowers', () => {
  expect(L.HANDOFF_PROBES).toEqual([
    'docs/superpowers/handoffs',
    'plans/handoffs',
    'docs/handoffs',
    '.claude/handoffs',
    'docs/superpowers',
  ])
})

test('openUrlArgv', () => {
  expect(L.openUrlArgv(false, 'claude://resume?session=1')).toEqual(['open', 'claude://resume?session=1'])
  expect(L.openUrlArgv(true, 'claude://resume?session=1')).toEqual(['rundll32', 'url.dll,FileProtocolHandler', 'claude://resume?session=1'])
})

// ---------- «файл записан?» (F-17) ----------

test('isWrittenSince: old file is not a written handoff', () => {
  expect(L.isWrittenSince(undefined, 10_000)).toBe(false)
  expect(L.isWrittenSince(5_000, 10_000)).toBe(false)
  expect(L.isWrittenSince(8_000, 10_000)).toBe(true)
  expect(L.isWrittenSince(12_000, 10_000)).toBe(true)
})

test('isWrittenSince: tolerance edge 7999/8000, mtime 0 is a time and not "missing"', () => {
  expect(L.isWrittenSince(7_999, 10_000)).toBe(false)
  expect(L.isWrittenSince(8_000, 10_000)).toBe(true)
  expect(L.isWrittenSince(10_000, 10_000)).toBe(true)
  expect(L.isWrittenSince(0, 1_000)).toBe(true)
  expect(L.isWrittenSince(0, 10_000)).toBe(false)
})
