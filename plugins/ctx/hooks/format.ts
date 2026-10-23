import { wordsOf, type Words } from './words'

export type Tone = 'normal' | 'warn' | 'alert' | 'dim'
export type Segment = { text: string; tone: Tone }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type LineInput = { percent: number | null; rateLimits: readonly Limit[]; usd: number | null; now: number; lastTurnAt: number }
export type LineOpts = { redAt: number; cacheMinutes: number; showCost: boolean; lang: string }

const CELLS = 8

// Подпись окна лимита на выбранном языке; kind, которого плагин не рисует, -> undefined.
function windowLabel(kind: string, w: Words): string | undefined {
  if (kind === 'five_hour') return w.fiveHour
  if (kind === 'seven_day') return w.sevenDay
  return undefined
}

export function bar(percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  const full = Math.round((p / 100) * CELLS)
  return '▪'.repeat(full) + '▫'.repeat(CELLS - full)
}

export function contextTone(percent: number, redAt: number): Tone {
  if (percent >= redAt) return 'alert'
  if (percent >= Math.min(50, redAt)) return 'warn'
  return 'normal'
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// Остаток до сброса 5-часового окна: `45м` меньше часа, `2ч14м` от часа (минуты двумя цифрами, чтобы строка не
// прыгала по ширине); единицы `ч` и `м` — из словаря языка (по-английски `45m`, `2h14m`). Минуты считаются с округлением
// ВВЕРХ, поэтому пока остаётся хоть миллисекунда, выходит не меньше одной минуты (`1м`); ноль минут не рисуется никогда.
// Времени сброса нет, оно не разбирается как дата или уже прошло (остаток <= 0) -> undefined: части `↻…` в строке
// нет. Верхней границы нет: остаток больше 5 часов показывается как есть.
function remainingText(resetsAt: string | undefined, now: number, w: Words): string | undefined {
  if (!resetsAt) return undefined
  const ms = new Date(resetsAt).getTime() - now
  if (Number.isNaN(ms) || ms <= 0) return undefined
  const minutes = Math.ceil(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}${w.hour}${pad2(minutes % 60)}${w.minute}` : `${minutes}${w.minute}`
}

// `now` нужен остатку 5-часового окна. Остаток считается заново при каждой сборке строки (draw в register.tsx), своего
// таймера у него нет: между замерами он убывает на минутном тике, пока тот запущен (он стартует на session.start и
// перезапускается на конце хода главной сессии).
export function limitSegment(l: Limit, now: number, w: Words): Segment | null {
  const label = windowLabel(l.kind, w)
  if (!label) return null
  const pct = Math.round(l.percentUsed)
  let text = `${label} ${bar(pct)} ${pct}%`
  if (l.kind === 'five_hour') {
    const left = remainingText(l.resetsAt, now, w)
    if (left !== undefined) text += ` ↻${left}`
  }
  // Недельное окно: день и время сброса в местном поясе; прошедшее время не проверяется (как в 0.2.0).
  if (l.kind === 'seven_day' && l.resetsAt) {
    const d = new Date(l.resetsAt)
    if (!Number.isNaN(d.getTime())) text += ` ↻${w.days[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  return { text, tone: pct >= 90 ? 'alert' : pct >= 70 ? 'warn' : 'normal' }
}

export function cacheSegment(now: number, lastTurnAt: number, cacheMinutes: number, w: Words): Segment | null {
  if (lastTurnAt <= 0) return null
  const elapsed = now - lastTurnAt
  if (elapsed >= cacheMinutes * 60_000) return { text: `${w.cache} ${w.cold}`, tone: 'dim' }
  return { text: `${w.cache} ${Math.floor(elapsed / 60_000)}${w.minute}`, tone: 'normal' }
}

export function costSegment(usd: number | null, show: boolean): Segment | null {
  if (!show || usd === null || usd === undefined) return null
  return { text: `$${usd.toFixed(2)}`, tone: 'normal' }
}

export function composeLine(i: LineInput, o: LineOpts): Segment[] {
  const w = wordsOf(o.lang)
  const out: Segment[] = []
  if (i.percent !== null && i.percent !== undefined) {
    const pct = Math.round(i.percent)
    // Слова «ctx» в тексте нет: Claude Code сам ставит перед статусом имя плагина.
    out.push({ text: `${bar(pct)} ${pct}%`, tone: contextTone(pct, o.redAt) })
  }
  for (const kind of ['five_hour', 'seven_day']) {
    const l = i.rateLimits.find(r => r.kind === kind)
    const s = l ? limitSegment(l, i.now, w) : null
    if (s) out.push(s)
  }
  const c = cacheSegment(i.now, i.lastTurnAt, o.cacheMinutes, w)
  if (c) out.push(c)
  const m = costSegment(i.usd, o.showCost)
  if (m) out.push(m)
  return out
}
