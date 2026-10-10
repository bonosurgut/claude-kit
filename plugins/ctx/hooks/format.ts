export type Tone = 'normal' | 'warn' | 'alert' | 'dim'
export type Segment = { text: string; tone: Tone }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type LineInput = { percent: number | null; rateLimits: readonly Limit[]; usd: number | null; now: number; lastTurnAt: number }
export type LineOpts = { redAt: number; cacheMinutes: number; showCost: boolean }

const CELLS = 8
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const LABELS: Record<string, string> = { five_hour: '5ч', seven_day: 'нед' }

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

export function limitSegment(l: Limit): Segment | null {
  const label = LABELS[l.kind]
  if (!label) return null
  const pct = Math.round(l.percentUsed)
  let text = `${label} ${bar(pct)} ${pct}%`
  if (l.kind === 'seven_day' && l.resetsAt) {
    const d = new Date(l.resetsAt)
    if (!Number.isNaN(d.getTime())) text += ` · сброс ${DAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  return { text, tone: pct >= 90 ? 'alert' : pct >= 70 ? 'warn' : 'normal' }
}

export function cacheSegment(now: number, lastTurnAt: number, cacheMinutes: number): Segment | null {
  if (lastTurnAt <= 0) return null
  const elapsed = now - lastTurnAt
  if (elapsed >= cacheMinutes * 60_000) return { text: 'кэш остыл', tone: 'dim' }
  return { text: `кэш ◷ ${Math.floor(elapsed / 60_000)}м`, tone: 'normal' }
}

export function costSegment(usd: number | null, show: boolean): Segment | null {
  if (!show || usd === null || usd === undefined) return null
  return { text: `$${usd.toFixed(2)}`, tone: 'normal' }
}

export function composeLine(i: LineInput, o: LineOpts): Segment[] {
  const out: Segment[] = []
  if (i.percent !== null && i.percent !== undefined) {
    const pct = Math.round(i.percent)
    // Слова «ctx» в тексте нет: Claude Code сам ставит перед статусом имя плагина.
    out.push({ text: `${bar(pct)} ${pct}%`, tone: contextTone(pct, o.redAt) })
  }
  for (const kind of ['five_hour', 'seven_day']) {
    const l = i.rateLimits.find(r => r.kind === kind)
    const s = l ? limitSegment(l) : null
    if (s) out.push(s)
  }
  const c = cacheSegment(i.now, i.lastTurnAt, o.cacheMinutes)
  if (c) out.push(c)
  const m = costSegment(i.usd, o.showCost)
  if (m) out.push(m)
  return out
}
