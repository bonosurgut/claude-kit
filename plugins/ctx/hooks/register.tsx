import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'
import type { CtxOptions, CtxSnapshot } from '../types'
import { statusLine } from './line'

const snapshot = atom({ plugin: 'ctx', key: 'snapshot' } as const, null as CtxSnapshot | null)
const lastTurnAt = atom({ plugin: 'ctx', key: 'lastTurnAt' } as const, 0)

const NOTHING_KNOWN: CtxSnapshot = { percent: null, rateLimits: [], usd: null }
const MINUTE_MS = 60_000

function take(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): CtxSnapshot {
  return {
    percent: u.context.percent ?? null,
    rateLimits: u.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}),
    })),
    usd: u.cost?.usd ?? null,
  }
}

// Пересобрать строку из state и часов и выставить её; undefined убирает строку.
// Рисуем строкой состояния под полем ввода ($.ui.status), как решено по пробе S-0
// (docs/probe-s0.md): её видно и в терминале, и в приложении. Здесь state только читается.
async function draw($: EngineInterface, options: CtxOptions) {
  const known = (await read($, snapshot)) ?? NOTHING_KNOWN
  const now = await $.clock.now()
  const last = await read($, lastTurnAt)
  $.ui.status(statusLine({ ...known, now, lastTurnAt: last }, options))
}

// Перерисовка из таймера: сбой не глотается молча, а уходит в отладочный журнал.
function redraw($: EngineInterface, options: CtxOptions) {
  draw($, options).catch(err => $.ui.log(`ctx: перерисовка не удалась: ${String(err)}`, { to: 'debug' }))
}

function everyMinute($: EngineInterface, options: CtxOptions): Timer {
  return $.clock.every(MINUTE_MS, () => redraw($, options))
}

// Ровно момент остывания кэша: срок может быть дробным (2.5 мин) и не попасть на минутный тик.
// Вызывается сразу после конца хода, поэтому ждать нужно весь срок. Таймер стартует уже
// после того, как конец хода прочитан с часов, так что раньше срока он не сработает
// (пока часы не идут назад).
function coldEdge($: EngineInterface, options: CtxOptions): Timer {
  return $.clock.after(Math.max(1, options.cacheMinutes * MINUTE_MS), () => redraw($, options))
}

export const register: Register = (on, rawOptions) => {
  const options = rawOptions as CtxOptions
  let minuteTimer: Timer | undefined
  let coldTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    // Таймер кэша идёт и без ходов: перерисовка раз в минуту. Повторный
    // session.start заменяет таймер, а не копит. Отсчёт минут тут идёт от старта;
    // после первого же хода главной сессии он перезапускается от конца хода.
    minuteTimer?.cancel()
    minuteTimer = everyMinute($, options)
    const usage = await $.session.usage()
    await update($, snapshot, () => take(usage))
    await draw($, options)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => take(e))
    await draw($, options)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Кэш считается по главной сессии: ход субагента его не обновляет.
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, lastTurnAt, () => now)
      // Минутные тики и момент остывания привязаны к концу этого хода, а не к старту
      // сессии; прежние таймеры отменяются, чтобы повторные ходы их не копили.
      minuteTimer?.cancel()
      coldTimer?.cancel()
      minuteTimer = everyMinute($, options)
      coldTimer = coldEdge($, options)
      await draw($, options)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear внутри живого процесса приходит как session.end, и session.start за ним не
    // следует (так сказано в типах движка); /resume сбрасываем так же, потому что процесс
    // продолжает работать под другим id. Без сброса старая строка осталась бы и
    // перерисовывалась по таймеру. Минутный таймер не трогаем: если session.start не придёт,
    // запустить его заново будет некому, а со сброшенным state он рисует пустую строку,
    // пока не придёт новое session.measure.
    if (e.reason === 'clear' || e.reason === 'resume') {
      coldTimer?.cancel()
      coldTimer = undefined
      await update($, snapshot, () => null)
      await update($, lastTurnAt, () => 0)
      $.ui.status(undefined)
    }
    return next(e)
  })
}
