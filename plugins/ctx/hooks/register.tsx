import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionUsage, Timer } from 'claude-code'
import type { AgentStates, CtxOptions, CtxSnapshot } from '../types'
import { agentsLabel, agentsRow, alignedCtxLabel, remember, retire, statesOf } from './agents'
import { shortFolder } from './folder'
import { SEPARATOR, statusLine } from './line'
import { wordsOf } from './words'

const snapshot = atom({ plugin: 'ctx', key: 'snapshot' } as const, null as CtxSnapshot | null)
const lastTurnAt = atom({ plugin: 'ctx', key: 'lastTurnAt' } as const, 0)
const line = atom({ plugin: 'ctx', key: 'line' } as const, null as string | null)
const agents = atom({ plugin: 'ctx', key: 'agents' } as const, {} as AgentStates)

// Подпись полосы: строку состояния подписывает сам движок (`ctx` / `⚠ ctx:`), полосу — никто.
// Когда над строкой ctx стоит строка агентов, подпись ctx выравнивается с подписью агентов выбранного языка
// (alignedCtxLabel). Подпись `ctx` на языки не делится.
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
// пробе S-0 (docs/probe-s0.md). В приложении шкалы стоят полосой над полем ввода (AbovePrompt,
// хук ниже), а строка состояния занята коротким именем папки сессии (F-25).
// JUSTIFIED-BY: приложение 3.1623.1 рисует строку состояния плагина в нижнем ряду слева от модели, а этот ряд узкий для строки шкал, поэтому шкалы идут полосой, а в ряду стоит одна папка (живая проба 2026-10-22) | UPGRADE: приложение уже дважды меняло это место (до 2.37 — в ряду с моделью, 2.37337 — отдельным рядом, 3.1623.1 — слева от модели); после обновления приложения повторить пробу мест вывода: если строка состояния ушла из ряда слева от модели — папка стоит не там, если ряд стал достаточно широким для шкал — шкалы можно вернуть в $.ui.status и убрать полосу
// Строка состояния у плагина одна на все поверхности, а полоса есть только в терминале и приложении,
// и в терминале мы её не рисуем. Поэтому папка стоит в строке состояния, только когда сессию видит
// одно приложение; терминал, телефон или VS Code рядом с ним (редко) оставляют строку себе: шкалы нужны
// им, а полосы у них нет.
function isAppOnly(surfaces: readonly RenderSurface[]): boolean {
  return surfaces.length > 0 && surfaces.every(s => s === 'desktop')
}

// Домашняя папка: на Windows USERPROFILE, иначе HOME. Имена переменных пишутся буквально: по тексту
// модуля движок узнаёт, какие переменные тот читает. Не прочиталась (хук отказал) — домашняя неизвестна,
// это правило «вне домашней».
async function homeFolder($: EngineInterface): Promise<string | undefined> {
  const isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  return (isWindows ? $.env.get('USERPROFILE') : $.env.get('HOME')).catch(() => undefined)
}

// Короткое имя папки сессии: корень сессии от движка (где сессия началась или куда её унесли `/cd` и перенос
// в рабочее дерево; `cd` оболочки его не двигает), а если движок отказал — текущая папка. Отказали оба — undefined: показывать нечего.
async function folderName($: EngineInterface): Promise<string | undefined> {
  const path = await $.session.root().catch(() => $.session.cwd()).catch(() => undefined)
  return path === undefined ? undefined : shortFolder(path, await homeFolder($))
}

// Пересобрать строку из state и часов, запомнить её для полосы и выставить строку состояния: папку
// сессии, если сессию видит одно приложение, иначе строку ctx; undefined убирает строку. Единственное
// место, которое решает, что стоит в строке состояния. Список поверхностей не ответил — считаем, что
// приложения нет. Папка читается ДО списка поверхностей, а не после: строка состояния выставляется сразу за
// ответом о поверхностях, без ожиданий движка между ними. Если бы поверхности читались первыми, их ответ успевал
// бы устареть за время чтения папки (несколько вызовов движка: корень сессии, при отказе корня текущая папка, ОС,
// домашняя): терминал или телефон, подключившийся за это время, получил бы папку вместо шкал, а перерисовка от
// самого подключения была бы затёрта этой, более старой, до ближайшей перерисовки (обычно это минутный тик). Цена: о папке движок спрашивается на каждой
// перерисовке, в том числе в терминале, где она не нужна.
async function draw($: EngineInterface, options: CtxOptions) {
  const known = (await read($, snapshot)) ?? NOTHING_KNOWN
  const now = await $.clock.now()
  const last = await read($, lastTurnAt)
  const text = statusLine({ ...known, now, lastTurnAt: last }, options)
  await update($, line, () => text ?? null)
  const folder = await folderName($)
  const surfaces = await $.session.surfaces().catch((): readonly RenderSurface[] => [])
  $.ui.status(isAppOnly(surfaces) ? folder : text)
}

// Перерисовка из таймера: сбой не глотается молча, а уходит в отладочный журнал.
function redraw($: EngineInterface, options: CtxOptions) {
  draw($, options).catch(err => $.ui.log(`ctx: перерисовка не удалась: ${String(err)}`, { to: 'debug' }))
}

// Перечитать список агентов у движка и слить его с учётом (remember): агент из списка получает своё текущее
// состояние, а пропавший из списка сохраняет последнее известное (работавший становится «готово»). Слияние
// идёт внутри update(), от учёта, который лежит в state в момент записи, а не от прочитанного раньше: update
// читает учёт, применяет функцию и пишет с проверкой версии (при промахе повторяет), поэтому два перечитывания
// одновременно (хук и минутный тик) не теряют ни одного агента. Сам список читается до update, один раз.
// Порядок записи важен и для слов: ответ на более раннее чтение может дописаться позже ответа на более позднее и
// вернуть агенту прежнее слово (`failed` снова стал бы `running`, а потом пропажа из списка сделала бы его «готово»).
// Поэтому каждое чтение берёт номер в момент вызова, ДО вопроса к движку, а `seenBy` помнит, каким по номеру
// чтением агента в последний раз ВИДЕЛИ В СПИСКЕ: чтение не трогает агентов, которых уже видело чтение с большим
// номером (см. seenLater в remember), а прочих, в том числе ещё не известных, обрабатывает как обычно.
// В `seenBy` пишется только то, что чтение видело в своём списке, а не то, что оно вывело: «агента в списке нет, значит
// он закончил» — догадка, и догадка более позднего чтения не должна перекрывать слово, которое более раннее чтение
// видело своими глазами (иначе увиденный `failed` навсегда стал бы «готово»). Цена: ответ более раннего чтения, где агент
// ещё «работает», дописанный после догадки более позднего, на время возвращает агента в «работает»; до следующего
// перечитывания, где агента по-прежнему нет в списке и вывод «готово» делается заново.
// JUSTIFIED-BY: движок отвечает на вопросы о списке в порядке их начала: ответ на более раннее чтение не свежее ответа на более позднее (в типах движка 2.1.304 для agent.list сказано «the session's agents so far», то есть на момент вопроса; порядок ответов на два вопроса, заданных подряд, там не сказан) | UPGRADE: если окажется, что ответ на более раннее чтение бывает свежее, номер чтения ничего не говорит о свежести списка; тогда сравнивать нужно по отметке времени самого списка (если движок её отдаёт) или читать список строго по одному
// Номер чтения и `seenBy` — переменные модуля, а не state: порядок чтений нужен тому экземпляру модуля, который
// их начал. После перезагрузки плагина номера начинаются заново, и чтение, начатое прежним экземпляром и дописанное
// новым, этим порядком не охвачено. Это переменные модуля, а не замыкание `register`: модуль загружается, только если `$`
// передаётся функциям, объявленным наверху файла или импортированным из файлов самого модуля, а функцию, собранную
// фабрикой, он не примет. `seenBy` обновляется внутри update (функция может вызваться повторно при
// промахе версии: с тем же номером она решает то же самое, а если между вызовами записалось чтение с большим номером,
// уступает ему); если запись сорвётся, чтения с меньшим номером всё равно
// не тронут этих агентов, и цифры догонит следующее чтение (конец хода или минутный тик). `seenBy` растёт на одну запись
// на каждого агента, которого видело чтение, до перезагрузки модуля (как и сам учёт, в котором агенты не удаляются).
// Запись в atom сама перерисовывает полосу, поэтому draw() отсюда не зовётся: от агентов зависит только полоса,
// а не строка состояния.
// Не бросает: если движок отказал, учёт остаётся прежним (пропавшие при этом не «заканчиваются»: слияния не было),
// отказ уходит в отладочный журнал, а цепочка хуков, из которой нас позвали, идёт дальше.
let readsStarted = 0
const seenBy = new Map<string, number>()
async function refreshAgents($: EngineInterface): Promise<void> {
  const generation = (readsStarted += 1)
  try {
    const list = await $.agent.list()
    const inList = Object.keys(statesOf(list))
    await update($, agents, previous => {
      const seenLater = (id: string) => (seenBy.get(id) ?? 0) > generation
      const merged = remember(previous, list, seenLater)
      for (const id of inList) if (!seenLater(id)) seenBy.set(id, generation)
      return merged
    })
  } catch (err) {
    $.ui.log(`ctx: список агентов не прочитан: ${String(err)}`, { to: 'debug' })
  }
}

// Минутный тик: перерисовка и перечитывание списка агентов. Оба не бросают, так что ни один не мешает другому.
function everyMinute($: EngineInterface, options: CtxOptions): Timer {
  return $.clock.every(MINUTE_MS, () => {
    redraw($, options)
    refreshAgents($)
  })
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
  // Язык строк (F-27) берётся из настроек один раз, при загрузке модуля, как redAt, cacheMinutes и showCost. Перехвата
  // изменения настроек в плагине нет: когда выбор `en` в /config дойдёт до строки (сразу или после перезагрузки
  // плагина), решает движок; это записывается живой проверкой, а не этим кодом.
  const words = wordsOf(options.lang)
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
    // Конец хода, главного или субагента, — повод перечитать список. Читаем после того, что ниже по цепочке:
    // это верно, если движок обновляет список до конца обработки события или в ней; если он обновит его позже,
    // цифры догонит следующее чтение (следующая точка перечитывания или минутный тик).
    const done = await next(e)
    await refreshAgents($)
    return done
  })

  // Субагент запускается: в списке его можно ждать, только когда запуск прошёл (next ответил), поэтому читаем после
  // него. Ответ запуска, в том числе отказ ({ deny }), проходит дальше как есть.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await refreshAgents($)
    return spawned
  })

  // Начало хода субагента: статус агента может смениться на работающий. agentId есть у хода субагента и участника
  // команды (участник в учёт не попадает, для него чтение просто лишнее); у хода главной сессии его нет, и она
  // список не перечитывает: для неё есть конец хода и минутный тик.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId) await refreshAgents($)
    return started
  })

  on('session.end', async ($, e, next) => {
    // /clear внутри живого процесса приходит как session.end, и session.start за ним не
    // следует (так сказано в типах движка); /resume сбрасываем так же, потому что процесс
    // продолжает работать под другим id. Без сброса старая строка осталась бы и
    // перерисовывалась по таймеру. Минутный таймер не трогаем: если session.start не придёт,
    // запустить его заново будет некому, а со сброшенным state он рисует пустую строку,
    // пока не придёт новое session.measure (в приложении вместо пустой строки он рисует папку).
    // Строку состояния перерисовываем, а не гасим: вне приложения она до нового замера пуста,
    // а папка в приложении остаётся (папка сессии та же). Учёт агентов (F-26) сбрасывается там же: это новый разговор,
    // и старые агенты в его счёт не входят. Учёт не очищается, а помечает каждый известный id «прежним разговором»
    // (retire): список агентов движка после `/clear` может продолжать отдавать старых, и очищенный учёт принял бы их
    // обратно при первом же перечитывании; чтение списка, начатое до `/clear` и дописанное после, упирается в те же
    // пометки. Агенты, которых плагин увидит впервые, считаются как обычно. Прочие причины конца (выход, logout, сигнал) учёт не трогают.
    if (e.reason === 'clear' || e.reason === 'resume') {
      coldTimer?.cancel()
      coldTimer = undefined
      await update($, snapshot, () => null)
      await update($, lastTurnAt, () => 0)
      await update($, line, () => null)
      await update($, agents, retire)
      await draw($, options)
    }
    return next(e)
  })

  // Приложение подключается к сессии обычно уже после старта: если оно остаётся единственной
  // поверхностью, строка состояния становится папкой, а при отключении снова строкой ctx.
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

  // Полоса над полем ввода в приложении, приглушённым текстом, сверху вниз: строка агентов (подпись и слова на
  // выбранном языке: «агенты  работают N ...» или «subagents  running N ...»; есть, только если учёт не пуст), строка
  // ctx (та же строка, что в терминале, с подписью «ctx»; нет данных — нет строки). Обе читаются из state, поэтому запись
  // в них перерисовывает полосу. Нет ни той, ни другой — полоса ничего не рисует.
  // Уступает опросу приложения; полосы других модов (то, что ниже по цепочке) остаются под нашими строками.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const text = await read($, line)
    const row = agentsRow(await read($, agents), words)
    if (text === null && row === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        {row === undefined ? null : <Text dimColor wrap="truncate-end">{agentsLabel(words) + row}</Text>}
        {text === null ? null : <Text dimColor wrap="truncate-end">{(row === undefined ? BAND_LABEL : alignedCtxLabel(words)) + text}</Text>}
        {theirs}
      </Box>
    )
  })
}
