import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionUsage, Timer } from 'claude-code'
import type { CtxOptions, CtxSnapshot } from '../types'
import { SEPARATOR, statusLine } from './line'

const snapshot = atom({ plugin: 'ctx', key: 'snapshot' } as const, null as CtxSnapshot | null)
const lastTurnAt = atom({ plugin: 'ctx', key: 'lastTurnAt' } as const, 0)
const line = atom({ plugin: 'ctx', key: 'line' } as const, null as string | null)

// Подпись полосы: строку состояния подписывает сам движок (`ctx` / `⚠ ctx:`), полосу — никто.
const BAND_LABEL = 'ctx' + SEPARATOR
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

// Где рисовать. В терминале — строкой состояния под полем ввода ($.ui.status), как решено по
// пробе S-0 (docs/probe-s0.md). В приложении — полосой над полем ввода (AbovePrompt, хук ниже),
// а строку состояния убираем, чтобы текст не стоял дважды.
// JUSTIFIED-BY: приложение 2.37337 ставит строку состояния плагина отдельным рядом под выбором модели, а вернуть её в ряд «Auto / Opus» мод не может: у $.ui.status нет места, SessionMode приложение не рисует, PromptHint не запрашивает (живая проба 2026-10-14) | UPGRADE: если приложение снова поставит строку состояния в ряд «Auto / Opus» или даст выбрать её место — вернуть $.ui.status на всех поверхностях и убрать полосу
// Строка состояния у плагина одна на все поверхности, а полоса есть только в терминале и приложении,
// и в терминале мы её не рисуем. Поэтому строку прячем, только когда сессию видит одно приложение:
// терминал, телефон или VS Code рядом с ним (редко) оставляют её себе.
function statusHidden(surfaces: readonly RenderSurface[]): boolean {
  return surfaces.length > 0 && surfaces.every(s => s === 'desktop')
}

// Пересобрать строку из state и часов, запомнить её для полосы и выставить строку состояния;
// undefined убирает строку. Список поверхностей не ответил — считаем, что приложения нет.
async function draw($: EngineInterface, options: CtxOptions) {
  const known = (await read($, snapshot)) ?? NOTHING_KNOWN
  const now = await $.clock.now()
  const last = await read($, lastTurnAt)
  const text = statusLine({ ...known, now, lastTurnAt: last }, options)
  await update($, line, () => text ?? null)
  const surfaces = await $.session.surfaces().catch((): readonly RenderSurface[] => [])
  $.ui.status(statusHidden(surfaces) ? undefined : text)
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
      await update($, line, () => null)
      $.ui.status(undefined)
    }
    return next(e)
  })

  // Приложение подключается к сессии обычно уже после старта: строку состояния тогда надо убрать,
  // а при отключении — вернуть.
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    await draw($, options)
    return joined
  })

  on('session.detach', async ($, e, next) => {
    const left = await next(e)
    await draw($, options)
    return left
  })

  // Полоса над полем ввода в приложении: та же строка с подписью «ctx», приглушённым текстом. Уступает опросу
  // приложения; полосы других модов (то, что ниже по цепочке) остаются под нашей строкой.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const text = await read($, line)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{BAND_LABEL + text}</Text>
        {theirs}
      </Box>
    )
  })
}
