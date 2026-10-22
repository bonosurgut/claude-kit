import { test, expect, mock } from 'claude-code/testing'
import type { AgentInfo, AgentStatus, On, RenderSurface, SessionUsage } from 'claude-code'

// F-26: строка субагентов в полосе над полем ввода. Один шов: плагин целиком против подменённого движка
// (список агентов, события, часы); наблюдается текст строк полосы, смонтированной для приложения и для терминала.
// Заглушки стоят ниже проверяемого: подсчёт и текст строки считает сам плагин.
//
// Откуда ожидаемые строки (независимо от кода плагина):
//  - спека ctx 0.2.0 (.scratch/ctx-folder-agents/spec.md), «Implementation Decisions» -> «Полоса» и «Учёт
//    агентов», истории 15-25 и 31-33: формат `работают N   готово M` и `   сбой K` только при K > 0; подписи
//    `агенты   …` и `ctx      …` (выровнены по ширине `агенты`, плюс три пробела), без строки агентов подпись
//    ctx прежняя `ctx   `; корзины: `completed` -> готово, `failed` и `killed` -> сбой, всё остальное (в том числе
//    слова, которых плагин не знает) -> работают; вложенные считаются, участники команды (teammateId) нет;
//  - слова состояния — AgentStatus из типов движка 2.1.304 (pending, running, waiting, idle, completed, failed, killed);
//  - числа в ожидаемых строках посчитаны руками по списку, поданному на вход теста.
// Решения задачи, которых в спеке нет, названы в тестах отдельно: имя начинается с `decision of the task`.
//
// Память учёта (тикет 03, раздел «Память учёта» в конце файла) берёт из спеки правила «Учёт агентов», «Память учёта»
// и «Сброс», истории 26-30: агент из списка получает своё текущее состояние (закончивший, которому написали, снова
// «работает»); пропавший из списка сохраняет последнее известное, а «работает» становится «готово» («сбой» остаётся
// «сбой», «готово» остаётся «готово»); отказ чтения списка учёт не меняет; `/clear` и `/resume` начинают счёт с нуля, даже
// если движок продолжает отдавать старых агентов; перезагрузка плагина цифры не сбрасывает. Ожидаемые числа там посчитаны руками по списку, поданному на вход.
//
// Порядок ответов (раздел «Ответы приходят не в том порядке…» перед отказом чтения) в спеке не описан: это решение
// задачи, его тесты начинаются с `decision of the task: out of order`. Чтение, начатое раньше, не отменяет слова агента,
// которое записало чтение, начатое позже и видевшее этого агента в своём списке; агентов, которых видело только оно,
// добавляет. Вывод «агента в списке нет, значит он закончил» слова, увиденного раньше, не отменяет: он не «видение».

const T0 = 1_000_000
const MIN = 60_000
const START = { cwd: '/work', surface: 'desktop', isInteractive: false } as const
const CTX = '▪▫▫▫▫▫▫▫ 10%' // процент 10 -> round(10 / 100 * 8) = 1 деление из 8
const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 93, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const AGENTS = 'агенты   '
const CTX_ALIGNED = 'ctx      '
const CTX_ALONE = 'ctx   '

const agent = (id: string, status: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: 'task',
  type: 'general-purpose',
  status: status as AgentStatus,
  ...over,
})
const teammate = (id: string, status: string) => agent(id, status, { teammateId: `${id}@team`, type: 'teammate' })

const turnComplete = (agentId?: string) => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})
const turnStart = (agentId?: string) => ({ text: '', turnId: 't1', ...(agentId ? { agentId } : {}) })

const usageOf = (): SessionUsage => ({ startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] })
const measureArg = (percent: number | undefined) => ({
  context: percent === undefined ? { window: 200_000 } : { window: 200_000, percent },
  rateLimits: [],
  changed: ['context' as const],
})

// Мир под плагином. `roster.now` — список агентов, который отдаёт движок (тест меняет его по ходу);
// `roster.refuse` — движок отказывает в чтении списка; `roster.reads` — сколько раз список прочитали;
// `roster.answer` — ответ на чтение по его номеру (вместо `now`);
// `roster.during` — что движок делает с ним в тот момент, когда событие уже дошло до дна цепочки
// (запуск агента, конец хода): так видно, читает ли плагин список до этого момента или после.
function world(on: On, surfaces: RenderSurface[] = ['desktop']) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/Users/anna' })
  on('session.root', () => ({ value: '/Users/anna/Desktop/CLAUDE/claude-kit' }))
  on('session.cwd', () => ({ value: '/work' }))
  const shown: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(`${e.to}: ${e.text}`)
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: [...surfaces] }))
  on('session.usage', () => ({ value: usageOf() }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const roster = {
    now: [] as AgentInfo[],
    refuse: false,
    reads: 0,
    during: undefined as (() => void) | undefined,
    // Ответ на конкретное чтение (по его номеру, с единицы) вместо `now`: так один тест держит два чтения в полёте сразу.
    answer: undefined as ((call: number) => Promise<AgentInfo[]>) | undefined,
  }
  on('agent.list', async () => {
    roster.reads += 1
    if (roster.refuse) return { deny: 'list refused' }
    return { value: roster.answer ? await roster.answer(roster.reads) : [...roster.now] }
  })
  on('agent.spawn', () => {
    roster.during?.()
    return { agentId: 'a-new', model: 'm' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => {
    roster.during?.()
    return { text: e.answer }
  })
  // То, что в полосе ниже нашего мода: видимый текст, чтобы тесты видели, что ctx его не съедает.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.hasSurvey ? 'survey' : 'below'] })
  })
  return { clock, shown, logs, roster }
}

// Все строки полосы сверху вниз (наши и то, что ниже).
async function lines(band: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  return (await band.findAll({ type: 'Text' })).map(t => t.text)
}

type World = ReturnType<typeof world>
type Dollar = Parameters<Parameters<typeof test>[1]>[0]

// Перечитать список: конец хода субагента. Ход главной сессии для этого не годится в тестах подсчёта: он добавляет
// в строку ctx сегмент кэша (`кэш ◷ 0м`), а здесь проверяется строка агентов, и строка ctx должна оставаться `CTX`.
const reread = ($: Dollar) => $.turn.complete(turnComplete('sub'))

// Мир с данными ctx (процент 10) и смонтированной полосой приложения.
async function desktopBand($: Dollar, w: World) {
  await $.session.measure(measureArg(10))
  return $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
}

// --- Подсчёт: корзины по словам движка ---

test('no agents: there is no agent row and the ctx label stays the old `ctx   `', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  // список прочитан и пуст: строки нет не потому, что его не спрашивали
  await reread($)
  expect(w.roster.reads).toBe(1)
  expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
})

test('one agent is working: `работают 1   готово 0` over the ctx line, labels in one column', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  const band = await desktopBand($, w)
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 0', CTX_ALIGNED + CTX, 'below'])
})

test('the same agent finishes: `работают 0   готово 1`', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  const band = await desktopBand($, w)
  await reread($)
  w.roster.now = [agent('a1', 'completed')]
  await $.turn.complete(turnComplete('a1'))
  expect(await lines(band)).toEqual([AGENTS + 'работают 0   готово 1', CTX_ALIGNED + CTX, 'below'])
})

test('labels are one width: the agent row and the ctx row start their text in the same column', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  const band = await desktopBand($, w)
  await reread($)
  const [agentsLine, ctxLine] = await lines(band)
  // спека: подпись ctx выровнена по ширине `агенты` (6 знаков) плюс разделитель в три пробела = 9
  expect(agentsLine!.indexOf('работают')).toBe(9)
  expect(ctxLine!.indexOf('▪')).toBe(9)
})

// Спека, «Полоса»: «Обе строки — тем же приглушённым моноширинным текстом». Приглушённость — свойство dimColor узла Text.
// Проверяется каждая строка отдельно: строка ctx без строки агентов покрыта в band.test.ts, а здесь обе строки вместе
// и строка агентов одна.
test('both rows are dim text: the agent row and the ctx row aligned under it', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  const band = await desktopBand($, w)
  await reread($)
  const texts = await band.findAll({ type: 'Text' })
  // три строки: агентов, ctx и то, что ниже нашего мода (оно не наше и приглушённым не обязано быть)
  expect(texts.map(t => t.text)).toEqual([AGENTS + 'работают 1   готово 0', CTX_ALIGNED + CTX, 'below'])
  expect(texts[0]!.props.dimColor).toBe(true)
  expect(texts[1]!.props.dimColor).toBe(true)
})

test('the agent row drawn alone (no ctx data) is dim text too', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  await $.session.measure(measureArg(undefined))
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await reread($)
  const texts = await band.findAll({ type: 'Text' })
  expect(texts.map(t => t.text)).toEqual([AGENTS + 'работают 1   готово 0', 'below'])
  expect(texts[0]!.props.dimColor).toBe(true)
})

// Все слова AgentStatus движка плюс одно слово, которого плагин не знает (спека: незнакомое слово -> «работают»).
const BUCKETS: [string, string][] = [
  ['pending', 'работают 1   готово 0'],
  ['running', 'работают 1   готово 0'],
  ['waiting', 'работают 1   готово 0'],
  ['idle', 'работают 1   готово 0'],
  ['completed', 'работают 0   готово 1'],
  ['failed', 'работают 0   готово 0   сбой 1'],
  ['killed', 'работают 0   готово 0   сбой 1'],
  ['hibernating', 'работают 1   готово 0'],
]
for (const [status, expected] of BUCKETS) {
  test(`status table: one agent "${status}" -> ${expected}`, async ($, on) => {
    const w = world(on)
    w.roster.now = [agent('a1', status)]
    const band = await desktopBand($, w)
    await reread($)
    expect(await lines(band)).toEqual([AGENTS + expected, CTX_ALIGNED + CTX, 'below'])
  })
}

test('failed and killed are `сбой 2` and are not in `готово`', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'failed'), agent('a2', 'killed')]
  const band = await desktopBand($, w)
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + 'работают 0   готово 0   сбой 2', CTX_ALIGNED + CTX, 'below'])
})

test('`сбой` stands after `готово` and counts only the failed: one completed, one failed', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'completed'), agent('a2', 'failed')]
  const band = await desktopBand($, w)
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + 'работают 0   готово 1   сбой 1', CTX_ALIGNED + CTX, 'below'])
})

test('three agents in the list: the three counters add up to exactly three', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running'), agent('a2', 'completed'), agent('a3', 'failed')]
  const band = await desktopBand($, w)
  await reread($)
  const row = (await lines(band))[0]!
  expect(row).toBe(AGENTS + 'работают 1   готово 1   сбой 1')
  const total = [...row.matchAll(/\d+/g)].reduce((sum, m) => sum + Number(m[0]), 0)
  expect(total).toBe(w.roster.now.length)
})

test('a mixed list of ten: the counters add up to the non-teammate agents of the input, a teammate is in none', async ($, on) => {
  const w = world(on)
  w.roster.now = [
    agent('a1', 'running'),
    agent('a2', 'pending'),
    agent('a3', 'waiting'),
    agent('a4', 'idle'),
    agent('a5', 'hibernating'),
    agent('a6', 'completed'),
    agent('a7', 'completed'),
    agent('a8', 'failed'),
    agent('a9', 'killed'),
    teammate('t1', 'running'),
    teammate('t2', 'completed'),
    agent('a10', 'completed'),
  ]
  // вход: 12 записей, из них 2 участника команды -> 10 субагентов
  const subagents = w.roster.now.filter(a => !a.teammateId).length
  expect(subagents).toBe(10)
  const band = await desktopBand($, w)
  await reread($)
  const row = (await lines(band))[0]!
  // работают: a1..a5 = 5; готово: a6, a7, a10 = 3; сбой: a8, a9 = 2
  expect(row).toBe(AGENTS + 'работают 5   готово 3   сбой 2')
  const total = [...row.matchAll(/\d+/g)].reduce((sum, m) => sum + Number(m[0]), 0)
  expect(total).toBe(subagents)
})

test('a nested agent (spawned by another agent) is counted, at any depth', async ($, on) => {
  const w = world(on)
  w.roster.now = [
    agent('p', 'running'),
    agent('c', 'completed', { parentId: 'p' }),
    agent('g', 'failed', { parentId: 'c' }),
  ]
  const band = await desktopBand($, w)
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 1   сбой 1', CTX_ALIGNED + CTX, 'below'])
})

test('a teammate is not counted: with a subagent beside it', async ($, on) => {
  const w = world(on)
  w.roster.now = [teammate('t1', 'running'), teammate('t2', 'failed'), agent('a1', 'completed')]
  const band = await desktopBand($, w)
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + 'работают 0   готово 1', CTX_ALIGNED + CTX, 'below'])
})

test('only teammates in the list: there is no agent row and the ctx label stays `ctx   `', async ($, on) => {
  const w = world(on)
  w.roster.now = [teammate('t1', 'running'), teammate('t2', 'idle')]
  const band = await desktopBand($, w)
  await reread($)
  expect(w.roster.reads).toBe(1)
  expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
})

// --- Полоса: что вокруг строки агентов ---

test('no ctx data (no percent) but agents present: the agent row is drawn alone', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  await $.session.measure(measureArg(undefined))
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 0', 'below'])
})

test('the app survey wins: no agent row, and it is back when the survey is gone', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  await $.session.measure(measureArg(10))
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  await reread($)
  expect(await lines(band)).toEqual(['survey'])
  await band.redraw(BAND)
  expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 0', CTX_ALIGNED + CTX, 'below'])
})

test('terminal: no agent row in the band, and the status line stays the ctx line', async ($, on) => {
  const w = world(on, ['terminal'])
  w.roster.now = [agent('a1', 'running')]
  await $.session.measure(measureArg(10))
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await reread($)
  expect(await lines(band)).toEqual(['below'])
  expect(w.shown[w.shown.length - 1]).toBe(CTX)
})

// --- Когда список перечитывается ---

// Каждая точка: список сменился, пока ничто не перечитывало (строки агентов ещё нет); событие — строка появилась.
// Минутный тик ставится на session.start, поэтому у каждой точки есть запуск сессии.
const POINTS: [string, ($: Dollar, w: World) => Promise<unknown>][] = [
  ['agent.spawn', $ => $.agent.spawn({ prompt: 'x' })],
  ['turn.start of a subagent', $ => $.turn.start(turnStart('a1'))],
  ['turn.complete of a subagent', $ => $.turn.complete(turnComplete('a1'))],
  ['turn.complete of the main session', $ => $.turn.complete(turnComplete())],
  ['the minute tick', (_$, w) => w.clock.advance(MIN)],
]
for (const [name, fire] of POINTS) {
  test(`the list is re-read at ${name}: the row appears at that event and not before`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    w.roster.now = [agent('a1', 'running')]
    expect(w.roster.reads).toBe(0)
    expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
    await fire($, w)
    expect(w.roster.reads).toBe(1)
    expect((await lines(band))[0]).toBe(AGENTS + 'работают 1   готово 0')
  })
}

test('turn.start of the main session does not re-read the list; of a subagent it does', async ($, on) => {
  const w = world(on)
  await $.turn.start(turnStart())
  expect(w.roster.reads).toBe(0)
  await $.turn.start(turnStart('a1'))
  expect(w.roster.reads).toBe(1)
})

// Порядок «сначала событие дошло до дна, потом список читаем» в спеке не записан (там только «после запуска агента»
// и «в конце хода»): это решение задачи. В типах движка не сказано, когда он обновляет список относительно
// хуков события; чтение после дна цепочки верно, если список обновляется до конца обработки события или в ней,
// а чтение до дна увидело бы тогда прежний список.
test('decision of the task: spawn is read after it went through: an agent that appears in the list during the spawn is counted', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  w.roster.during = () => {
    w.roster.now = [agent('a-new', 'pending')]
  }
  const result = await $.agent.spawn({ prompt: 'x' })
  expect(result).toEqual({ agentId: 'a-new', model: 'm' })
  expect((await lines(band))[0]).toBe(AGENTS + 'работают 1   готово 0')
})

test('decision of the task: the end of a turn is read after it went through: an agent finishing during it is counted as done', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  const band = await desktopBand($, w)
  await reread($)
  expect((await lines(band))[0]).toBe(AGENTS + 'работают 1   готово 0')
  w.roster.during = () => {
    w.roster.now = [agent('a1', 'completed')]
  }
  expect(await $.turn.complete(turnComplete('a1'))).toEqual({ text: 'ok' })
  expect((await lines(band))[0]).toBe(AGENTS + 'работают 0   готово 1')
})

test('a re-read draws only the band: the status line is not written again', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const before = w.shown.length
  w.roster.now = [agent('a1', 'running')]
  await $.agent.spawn({ prompt: 'x' })
  await $.turn.start(turnStart('a1'))
  await $.turn.complete(turnComplete('a1'))
  expect((await lines(band))[0]).toBe(AGENTS + 'работают 1   готово 0')
  // turn.complete субагента строку состояния не перерисовывает (кэш считается по главной сессии)
  expect(w.shown.length).toBe(before)
})

test('the plugin only observes: the answers of agent.spawn, turn.start and turn.complete pass through unchanged', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running')]
  expect(await $.agent.spawn({ prompt: 'x' })).toEqual({ agentId: 'a-new', model: 'm' })
  expect(await $.turn.start(turnStart('a1'))).toEqual({ turnId: 't1' })
  expect(await $.turn.complete(turnComplete('a1'))).toEqual({ text: 'ok' })
})

// --- Отказ чтения списка: не ломает цепочку, цифры прежние (отказ после слияния с пропавшими — в «Памяти учёта» ниже) ---

test('a refused list read does not break the chain and leaves the last numbers on the band', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running'), agent('a2', 'completed')]
  const band = await desktopBand($, w)
  await reread($)
  expect((await lines(band))[0]).toBe(AGENTS + 'работают 1   готово 1')
  w.roster.refuse = true
  w.roster.now = [agent('a1', 'completed'), agent('a2', 'completed'), agent('a3', 'failed')] // не должно быть прочитано
  expect(await $.agent.spawn({ prompt: 'x' })).toEqual({ agentId: 'a-new', model: 'm' })
  expect(await $.turn.start(turnStart('a1'))).toEqual({ turnId: 't1' })
  expect(await $.turn.complete(turnComplete('a1'))).toEqual({ text: 'ok' })
  expect(await $.turn.complete(turnComplete())).toEqual({ text: 'ok' })
  await w.clock.advance(MIN)
  // после отказа чтений пять (запуск, начало и конец хода субагента, конец хода главной сессии, минутный тик) и одно до него
  expect(w.roster.reads).toBe(6)
  // каждый отказ ушёл в отладочный журнал, а не пропал молча
  expect(w.logs.length).toBe(5)
  expect(w.logs.every(entry => entry.startsWith('debug: '))).toBe(true)
  // цифры прежние; сегмент кэша в строке ctx — от конца хода главной сессии минуту назад (как в band.test.ts)
  expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 1', CTX_ALIGNED + CTX + '   кэш ◷ 1м', 'below'])
  // и когда движок снова отвечает, учёт обновляется: отказ не заклинил полосу
  w.roster.refuse = false
  await $.turn.complete(turnComplete('a1'))
  expect((await lines(band))[0]).toBe(AGENTS + 'работают 0   готово 2   сбой 1')
})

// --- Память учёта (тикет 03, F-26) ---
//
// Правила — спека ctx 0.2.0, «Память учёта» и «Сброс»; ожидания в таблицах и сценариях написаны руками из этих правил
// и из входа теста (списка, который подаёт заглушка), а не списаны с вывода плагина. Заглушён только `agent.list` (по
// чтению: тест сам убирает агента из списка между чтениями) и события; слияние учёта идёт в самом плагине.

const WORK = 'работают 1   готово 0'
const DONE_ONE = 'работают 0   готово 1'
const FAIL_ONE = 'работают 0   готово 0   сбой 1'

const sumOf = (row: string) => [...row.matchAll(/\d+/g)].reduce((sum, m) => sum + Number(m[0]), 0)
const rowOf = async (band: Parameters<typeof lines>[0]) => (await lines(band))[0]!

// Агент остаётся в списке: его текущее состояние выигрывает у запомненного, каким бы оно ни было (спека: «агент из
// списка получает своё текущее состояние»; закончивший, которому написали, снова «работает»). Строки BUCKETS выше —
// корзина по слову, здесь она же для каждого «было».
for (const was of ['none', 'running', 'completed', 'failed', 'killed']) {
  for (const [now, expected] of BUCKETS) {
    test(`memory table: was ${was}, still in the list as "${now}" -> ${expected}`, async ($, on) => {
      const w = world(on)
      const band = await desktopBand($, w)
      if (was !== 'none') {
        w.roster.now = [agent('a1', was)]
        await reread($)
      }
      w.roster.now = [agent('a1', now)]
      await reread($)
      expect(await lines(band)).toEqual([AGENTS + expected, CTX_ALIGNED + CTX, 'below'])
    })
  }
}

// Агент пропал из списка: «работает» (любое слово, кроме трёх слов конца, в том числе незнакомое) -> «готово»;
// «готово» остаётся «готово»; «сбой» (failed и killed) остаётся «сбой».
const VANISHED: [string, string][] = [
  ['running', DONE_ONE],
  ['pending', DONE_ONE],
  ['waiting', DONE_ONE],
  ['idle', DONE_ONE],
  ['hibernating', DONE_ONE],
  ['completed', DONE_ONE],
  ['failed', FAIL_ONE],
  ['killed', FAIL_ONE],
]
for (const [was, expected] of VANISHED) {
  test(`memory table: was "${was}", gone from the list -> ${expected}`, async ($, on) => {
    const w = world(on)
    w.roster.now = [agent('a1', was)]
    const band = await desktopBand($, w)
    await reread($)
    w.roster.now = []
    await reread($)
    expect(w.roster.reads).toBe(2)
    expect(await lines(band)).toEqual([AGENTS + expected, CTX_ALIGNED + CTX, 'below'])
  })
}

test('an agent that was never in any list is not in the tally: the row does not appear out of nothing', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  await reread($)
  await reread($)
  expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
})

test('a vanished agent is neither forgotten nor doubled when the list is read again and again without it', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('a1', 'running'), agent('a2', 'failed')]
  const band = await desktopBand($, w)
  await reread($)
  w.roster.now = []
  for (let i = 0; i < 4; i += 1) await reread($)
  expect(w.roster.reads).toBe(5)
  expect(await lines(band)).toEqual([AGENTS + 'работают 0   готово 1   сбой 1', CTX_ALIGNED + CTX, 'below'])
})

// Сценарий из спеки по шагам: на каждом шаге список, который отдаёт движок, и строка, которую видит человек.
// Строки написаны до запуска, по правилам памяти; в конце каждого шага число учтённых равно числу разных
// не-участников команды, которых заглушка когда-либо отдавала (вход считается здесь, а не по выводу плагина).
test('scripted sequence: spawn A, spawn B, A done, A vanishes, B fails, B vanishes, A resumes, C joins, all vanish', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const steps: [string, AgentInfo[], string][] = [
    ['spawn A', [agent('A', 'running')], 'работают 1   готово 0'],
    ['spawn B', [agent('A', 'running'), agent('B', 'running')], 'работают 2   готово 0'],
    ['A completes', [agent('A', 'completed'), agent('B', 'running')], 'работают 1   готово 1'],
    ['A vanishes from the list', [agent('B', 'running')], 'работают 1   готово 1'],
    ['B fails', [agent('B', 'failed')], 'работают 0   готово 1   сбой 1'],
    ['B vanishes from the list', [], 'работают 0   готово 1   сбой 1'],
    ['A is written to and runs again', [agent('A', 'running')], 'работают 1   готово 0   сбой 1'],
    ['C joins, a teammate is beside them', [agent('A', 'running'), agent('C', 'running'), teammate('T', 'running')], 'работают 2   готово 0   сбой 1'],
    ['A and C vanish while working, the teammate too', [], 'работают 0   готово 2   сбой 1'],
    ['B is written to and runs again', [agent('B', 'running')], 'работают 1   готово 2'],
    ['B vanishes while working', [], 'работают 0   готово 3'],
  ]
  const seen = new Set<string>()
  for (const [label, list, expected] of steps) {
    w.roster.now = list
    for (const a of list) if (!a.teammateId) seen.add(a.id)
    await reread($)
    const row = await rowOf(band)
    expect(row, label).toBe(AGENTS + expected)
    expect(sumOf(row), label).toBe(seen.size)
  }
  expect(seen.size).toBe(3)
  expect(w.roster.reads).toBe(steps.length)
})

// Сужение: учёт не теряет ни одного увиденного id. Последовательность псевдослучайная, но фиксированная (одно зерно):
// в каждом чтении любой из шести субагентов есть или нет, с любым из восьми слов, и два участника команды. Число
// учтённых после каждого чтения == число разных субагентов, которых заглушка отдавала с последнего сброса.
test('narrowing: after any sequence the tally holds exactly the distinct non-teammate ids the list ever returned', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const words = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed', 'hibernating']
  let seed = 20_261_022
  const next = (n: number) => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    return (seed >>> 8) % n
  }
  const seen = new Set<string>()
  for (let step = 0; step < 60; step += 1) {
    const list: AgentInfo[] = []
    for (let i = 0; i < 6; i += 1) if (next(2) === 1) list.push(agent(`s${i}`, words[next(words.length)]!))
    for (let i = 0; i < 2; i += 1) if (next(2) === 1) list.push(teammate(`t${i}`, words[next(words.length)]!))
    w.roster.now = list
    for (const a of list) if (!a.teammateId) seen.add(a.id)
    await reread($)
    const first = await rowOf(band)
    if (seen.size === 0) {
      expect(first, `step ${step}`).toBe(CTX_ALONE + CTX)
    } else {
      expect(first.startsWith(AGENTS), `step ${step}`).toBe(true)
      expect(sumOf(first), `step ${step}`).toBe(seen.size)
    }
  }
  // сам прогон не пустой: за 60 чтений заглушка отдала все шесть субагентов
  expect(seen.size).toBe(6)
})

test('a teammate that was in a list and then vanished is not in the tally either', async ($, on) => {
  const w = world(on)
  w.roster.now = [teammate('t1', 'running'), agent('a1', 'running')]
  const band = await desktopBand($, w)
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + WORK)
  w.roster.now = []
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + DONE_ONE)
})

// --- Два перечитывания одновременно ---

// Слияние идёт внутри update() из учёта, который лежит там в этот момент. Здесь два чтения списка в полёте сразу:
// оба получили свой список до того, как любое из них записало. Если бы плагин считал слияние от учёта, прочитанного
// раньше, второй записавший затёр бы первого. Списки подобраны так, что результат не зависит от того, кто запишет
// первым: A закончил, B упал; в любом порядке готово 1 и сбой 1.
test('two re-reads in flight at once do not overwrite each other: both agents stay in the tally', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const lists = [[agent('A', 'completed')], [agent('B', 'failed')]]
  let started = 0
  let release!: () => void
  const bothStarted = new Promise<void>(resolve => {
    release = resolve
  })
  w.roster.answer = async call => {
    started += 1
    if (started === 2) release()
    await bothStarted
    return lists[call - 1]!
  }
  // конец хода субагента и начало хода другого субагента: два разных повода перечитать
  await Promise.all([$.turn.complete(turnComplete('x')), $.turn.start(turnStart('y'))])
  expect(w.roster.reads).toBe(2)
  expect(await lines(band)).toEqual([AGENTS + 'работают 0   готово 1   сбой 1', CTX_ALIGNED + CTX, 'below'])
})

// --- Ответы приходят не в том порядке, в каком чтения начались ---
//
// Правило — решение, которого в спеке нет (спека про порядок ответов молчит): чтение, начатое раньше, не отменяет
// слова агента, которое уже записало чтение, начатое позже; агента, которого видело только отставшее чтение, оно
// всё равно добавляет. Номера чтений в тестах — порядок ИХ НАЧАЛА (`roster.answer(call)` получает номер вопроса к
// движку), а порядок записи задают ворота: ответ на чтение отдаётся, когда тест откроет его ворота.
// Ожидаемые строки посчитаны руками по спискам, которые подаёт заглушка: слово последнего начатого чтения, в списке
// которого агент был; пропажа из списка действует только на агентов, которых чтение, начатое позже, в своём списке не видело.

// Ворота на каждое чтение: gate(n) — обещание, которое ждёт чтение номер n; open(n) его отпускает.
function gatesFor(count: number) {
  const opens: (() => void)[] = []
  const promises = Array.from({ length: count }, (_, i) => new Promise<void>(resolve => { opens[i] = resolve }))
  return { wait: (call: number) => promises[call - 1]!, open: (call: number) => opens[call - 1]!() }
}

test('decision of the task: out of order: an earlier read written later does not lower a status a later read wrote; failed stays failed, also after the agent vanishes', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const gates = gatesFor(2)
  // чтение 1 получает [A running] и отдаёт его последним; чтение 2 получает [A failed] и пишет первым
  w.roster.answer = async call => {
    await gates.wait(call)
    return call === 1 ? [agent('A', 'running')] : [agent('A', 'failed')]
  }
  const first = $.turn.complete(turnComplete('x'))
  await w.clock.settle()
  expect(w.roster.reads).toBe(1) // чтение 1 началось и ждёт ворот
  const second = $.turn.start(turnStart('y'))
  await w.clock.settle()
  expect(w.roster.reads).toBe(2)
  gates.open(2)
  await second
  expect(await rowOf(band)).toBe(AGENTS + FAIL_ONE)
  gates.open(1)
  await first
  expect(await rowOf(band)).toBe(AGENTS + FAIL_ONE) // «сбой» не стал «работают»
  // A пропал из списка: без возврата в «работает» он остаётся «сбой», а не уходит в «готово»
  w.roster.answer = undefined
  w.roster.now = []
  await reread($)
  expect(w.roster.reads).toBe(3)
  expect(await rowOf(band)).toBe(AGENTS + FAIL_ONE)
  // отставшее чтение не заклинило учёт: следующее чтение (начатое позже всех) принимается
  w.roster.now = [agent('A', 'failed'), agent('B', 'running')]
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 1   готово 0   сбой 1')
})

test('decision of the task: out of order: an earlier read that does not list an agent does not finish it for a later read that did', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const gates = gatesFor(2)
  // чтение 1 началось, когда агента ещё не было в списке, и отдаёт [] последним; чтение 2 видит A running и пишет первым
  w.roster.answer = async call => {
    await gates.wait(call)
    return call === 1 ? [] : [agent('A', 'running')]
  }
  const first = $.turn.complete(turnComplete('x'))
  await w.clock.settle()
  const second = $.turn.start(turnStart('y'))
  await w.clock.settle()
  expect(w.roster.reads).toBe(2)
  gates.open(2)
  await second
  expect(await rowOf(band)).toBe(AGENTS + WORK)
  gates.open(1)
  await first
  expect(await rowOf(band)).toBe(AGENTS + WORK) // работает, а не «готово»: пропажа из списка устаревшего ответа его не касается
})

test('decision of the task: out of order: three reads written as 3, 1, 2 leave what the last started one said', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const gates = gatesFor(3)
  const lists = [
    [agent('A', 'running')],
    [agent('A', 'running'), agent('B', 'running')],
    [agent('A', 'completed'), agent('B', 'failed')],
  ]
  w.roster.answer = async call => {
    await gates.wait(call)
    return lists[call - 1]!
  }
  const reads: Promise<unknown>[] = []
  for (const who of ['x1', 'x2', 'x3']) {
    reads.push($.turn.complete(turnComplete(who)))
    await w.clock.settle()
  }
  expect(w.roster.reads).toBe(3)
  const final = AGENTS + 'работают 0   готово 1   сбой 1'
  gates.open(3)
  await reads[2]
  expect(await rowOf(band)).toBe(final)
  gates.open(1)
  await reads[0]
  expect(await rowOf(band)).toBe(final)
  gates.open(2)
  await reads[1]
  expect(await rowOf(band)).toBe(final)
})

// Обратная сторона: чтение, которое отстало, не должно ещё и терять агентов, которых видело только оно. Зеркало теста
// «two re-reads in flight at once» (там старшее чтение пишет первым): здесь первым пишет младшее, у каждого свой агент.
test('decision of the task: out of order: an agent only the earlier read saw is still counted when that read is written last', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  const gates = gatesFor(2)
  const lists = [[agent('A', 'completed')], [agent('B', 'failed')]]
  w.roster.answer = async call => {
    await gates.wait(call)
    return lists[call - 1]!
  }
  const first = $.turn.complete(turnComplete('x'))
  await w.clock.settle()
  const second = $.turn.start(turnStart('y'))
  await w.clock.settle()
  expect(w.roster.reads).toBe(2)
  gates.open(2)
  await second
  expect(await rowOf(band)).toBe(AGENTS + FAIL_ONE) // пока только B
  gates.open(1)
  await first
  // и A, и B: 2 агента на входе (по одному в списке каждого чтения), готово 1 (A) и сбой 1 (B)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 0   готово 1   сбой 1')
})

// Догадка не перекрывает наблюдение. «Пропал из списка» — вывод плагина, а не то, что чтение видело: чтение 3 с пустым
// списком выводит из пропажи «готово», а чтение 2, начатое раньше, своими глазами видело `failed`. Каким бы ни был порядок
// записи, «сбой» остаётся (ожидание посчитано по входу: агент A упал, чтение 2 это видело, движок потом убрал его из списка).
// Когда вывод записан первым, между двумя записями в строке на время стоит «готово» (проверяется ниже); итог один.
for (const order of ['the inferring read is written first', 'the observing read is written first'] as const) {
  test(`decision of the task: out of order: a vanish inferred by a later read does not override what an earlier read saw, failed stays failed (${order})`, async ($, on) => {
    const w = world(on)
    const band = await desktopBand($, w)
    const gates = gatesFor(3)
    // чтение 1 (сразу): [A running], A в учёте «работает»; чтение 2 (ворота): [A failed]; чтение 3 (ворота): [], A уже убран из списка
    const lists = [[agent('A', 'running')], [agent('A', 'failed')], []]
    w.roster.answer = async call => {
      if (call > 1) await gates.wait(call)
      return lists[call - 1]!
    }
    await reread($)
    expect(await rowOf(band)).toBe(AGENTS + WORK)
    const second = $.turn.complete(turnComplete('x2'))
    await w.clock.settle()
    const third = $.turn.start(turnStart('x3'))
    await w.clock.settle()
    expect(w.roster.reads).toBe(3)
    const first = order === 'the inferring read is written first' ? 3 : 2
    const last = first === 3 ? 2 : 3
    const done = { 2: second, 3: third }
    gates.open(first)
    await done[first]
    expect(await rowOf(band)).toBe(AGENTS + (first === 3 ? DONE_ONE : FAIL_ONE))
    gates.open(last)
    await done[last]
    expect(await rowOf(band)).toBe(AGENTS + FAIL_ONE)
    // и следующее чтение, где A по-прежнему нет, его не меняет: «сбой» остаётся «сбой»
    w.roster.answer = undefined
    w.roster.now = []
    await reread($)
    expect(w.roster.reads).toBe(4)
    expect(await rowOf(band)).toBe(AGENTS + FAIL_ONE)
  })
}

// --- Отказ чтения списка после того, как учёт уже что-то помнит ---

test('a refused read does not finish the working agents of the tally and does not drop the band; the next good read does', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('A', 'running'), agent('B', 'failed'), agent('C', 'completed')]
  const band = await desktopBand($, w)
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 1   готово 1   сбой 1')
  // движок отказывает, а настоящий список уже пуст: пока он не прочитан, A остаётся «работает»
  w.roster.refuse = true
  w.roster.now = []
  await $.agent.spawn({ prompt: 'x' })
  await $.turn.start(turnStart('A'))
  await $.turn.complete(turnComplete('A'))
  await $.turn.complete(turnComplete())
  await w.clock.advance(MIN)
  expect(w.roster.reads).toBe(6)
  expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 1   сбой 1', CTX_ALIGNED + CTX + '   кэш ◷ 1м', 'below'])
  w.roster.refuse = false
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 0   готово 2   сбой 1')
})

test('the very first read refused: no agent row, the ctx row keeps its old label, nothing is thrown', async ($, on) => {
  const w = world(on)
  w.roster.refuse = true
  const band = await desktopBand($, w)
  await reread($)
  expect(w.roster.reads).toBe(1)
  expect(w.logs.length).toBe(1)
  expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
})

// --- /clear и /resume ---
//
// Сброс не может опираться на то, что движок уберёт старых агентов из списка: типы движка этого не обещают (запись
// агента живёт, пока движок не снимет его задачу, у субагента позже конца), про `/clear` в них ничего нет. Поэтому
// заглушка во всех тестах ниже ПРОДОЛЖАЕТ отдавать агентов прежнего разговора после session.end (в том числе с
// другими словами), а считать их плагин не должен. Правило — спека, «Сброс» и история 29: после `/clear` счёт агентов
// начинается с нуля, потому что это новый разговор; агент нового разговора считается как обычно.

const BEFORE_CLEAR = () => [agent('A', 'running'), agent('B', 'failed'), agent('C', 'completed')]
const BEFORE_CLEAR_ROW = AGENTS + 'работают 1   готово 1   сбой 1'
const END = (reason: 'clear' | 'resume', n = 1) => ({ reason, sessionId: `s${n}`, resume: { id: `s${n}` } })

for (const reason of ['clear', 'resume'] as const) {
  test(`session.end ${reason}: the engine still lists the old agents, none of them is counted, the new one is`, async ($, on) => {
    const w = world(on)
    w.roster.now = BEFORE_CLEAR()
    const band = await desktopBand($, w)
    await reread($)
    expect(await rowOf(band)).toBe(BEFORE_CLEAR_ROW)
    expect(await $.session.end(END(reason))).toEqual({ sessionId: 's1' })
    // ни строки агентов, ни строки ctx (она тоже сброшена, как раньше)
    expect(await lines(band)).toEqual(['below'])
    // движок отдаёт тех же троих, уже с другими словами; пришли данные о контексте: строки агентов нет, подпись ctx прежняя
    w.roster.now = [agent('A', 'completed'), agent('B', 'running'), agent('C', 'failed')]
    await $.session.measure(measureArg(10))
    await reread($)
    expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
    // конец хода главной сессии и минутный тик читают список снова, и опять строки агентов нет
    await $.turn.complete(turnComplete())
    expect(await lines(band)).toEqual([CTX_ALONE + CTX + '   кэш ◷ 0м', 'below'])
    await w.clock.advance(MIN)
    expect(await lines(band)).toEqual([CTX_ALONE + CTX + '   кэш ◷ 1м', 'below'])
    // чтений было четыре (до сброса одно, потом конец хода субагента, конец хода главной сессии, тик): список правда читали
    expect(w.roster.reads).toBe(4)
    // первый агент нового разговора считается как есть: старые A, B и C в счёт не входят, хотя движок их отдаёт
    w.roster.now = [agent('A', 'completed'), agent('B', 'running'), agent('C', 'failed'), agent('D', 'running')]
    await reread($)
    expect(await lines(band)).toEqual([AGENTS + WORK, CTX_ALIGNED + CTX + '   кэш ◷ 1м', 'below'])
    // и дальше D живёт по общим правилам: закончил -> готово
    w.roster.now = [agent('A', 'completed'), agent('B', 'running'), agent('C', 'failed'), agent('D', 'completed')]
    await reread($)
    expect(await rowOf(band)).toBe(AGENTS + DONE_ONE)
  })
}

// Старый агент остаётся вне счёта, какое бы слово движок ни вернул для его id (спека: счёт нового разговора с нуля).
for (const [word] of BUCKETS) {
  test(`session.end clear: an old agent the engine still lists as "${word}" is not counted`, async ($, on) => {
    const w = world(on)
    w.roster.now = [agent('A', 'running')]
    const band = await desktopBand($, w)
    await reread($)
    await $.session.end(END('clear'))
    w.roster.now = [agent('A', word)]
    await $.session.measure(measureArg(10))
    await reread($)
    expect(w.roster.reads).toBe(2)
    expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
  })
}

// Чтение списка, начатое до `/clear` и дописанное после него, старый счёт не оживляет. Чтение держится на воротах:
// оно уже началось (движок получил запрос) к моменту сброса, а ответ отдаёт после.
for (const reason of ['clear', 'resume'] as const) {
  test(`a list read that started before session.end ${reason} and finished after it does not bring the old count back`, async ($, on) => {
    const w = world(on)
    w.roster.now = BEFORE_CLEAR()
    const band = await desktopBand($, w)
    await reread($)
    expect(await rowOf(band)).toBe(BEFORE_CLEAR_ROW)
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    w.roster.answer = async () => {
      await gate
      return BEFORE_CLEAR()
    }
    const inFlight = $.turn.complete(turnComplete('x'))
    await w.clock.settle()
    expect(w.roster.reads).toBe(2) // чтение началось и ждёт ворот
    await $.session.end(END(reason))
    release()
    await inFlight
    expect(await lines(band)).toEqual(['below'])
    await $.session.measure(measureArg(10))
    expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
  })
}

test('the second session.end clear marks the agents of the conversation between the two clears as well', async ($, on) => {
  const w = world(on)
  w.roster.now = BEFORE_CLEAR()
  const band = await desktopBand($, w)
  await reread($)
  await $.session.end(END('clear', 1))
  w.roster.now = [...BEFORE_CLEAR(), agent('D', 'running')]
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + WORK) // только D
  await $.session.end(END('clear', 2))
  w.roster.now = [...BEFORE_CLEAR(), agent('D', 'running'), agent('E', 'running')]
  await $.session.measure(measureArg(10))
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + WORK, CTX_ALIGNED + CTX, 'below']) // только E
})

test('session.end clear twice in a row: still no agent row, nothing thrown', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('A', 'failed')]
  const band = await desktopBand($, w)
  await reread($)
  await $.session.end(END('clear', 1))
  await $.session.end(END('clear', 2))
  await $.session.measure(measureArg(10))
  await reread($)
  expect(await lines(band)).toEqual([CTX_ALONE + CTX, 'below'])
})

test('session.end clear with nothing in the tally yet: the first agent afterwards is counted', async ($, on) => {
  const w = world(on)
  const band = await desktopBand($, w)
  await $.session.end(END('clear'))
  await $.session.measure(measureArg(10))
  w.roster.now = [agent('D', 'running')]
  await reread($)
  expect(await lines(band)).toEqual([AGENTS + WORK, CTX_ALIGNED + CTX, 'below'])
})

// Спека называет сброс только для /clear и /resume («как сейчас сбрасывается строка ctx»); другие причины конца сессии
// строку ctx не трогают (status.test.ts), и учёт агентов ведёт себя так же: это решение задачи, которого в спеке нет.
for (const reason of ['prompt_input_exit', 'logout', 'other'] as const) {
  test(`decision of the task: session.end ${reason} leaves the agent tally as it was`, async ($, on) => {
    const w = world(on)
    w.roster.now = [agent('A', 'running'), agent('B', 'failed')]
    const band = await desktopBand($, w)
    await reread($)
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    expect(await lines(band)).toEqual([AGENTS + 'работают 1   готово 0   сбой 1', CTX_ALIGNED + CTX, 'below'])
  })
}

// --- Перезагрузка плагина посреди сессии ---
//
// Тестовый движок перезагрузку плагина разыграть не умеет: в типах `claude-code/testing` нет ни reload, ни remount,
// `mock` отвечает только за часы, хранилище, окружение и запись в сессию, а плагин загружается при первом вызове `$`.
// Настоящее «модуль потерял переменные, а state остался» здесь не проверить. Вместо него два косвенных довода:
//  - повторный session.start (в типах движка: он идёт и при перезагрузке плагина) учёт не сбрасывает; этот довод
//    не говорит, ГДЕ учёт хранится, только что хук запуска его не трогает;
//  - учёт лежит в state плагина (ключ `ctx.agents`, объявлен в types/index.d.ts), а не в переменной модуля: то, что
//    в state уже лежит, плагин рисует и сливает со списком без единого своего чтения или записи до того. Тест
//    подменяет ответ движка на чтение этого ключа, как будто его оставил прежний экземпляр модуля. Модульная
//    переменная этого не увидела бы. Что перезагрузка сохраняет state, тест не проверяет: это обещание движка
//    (типы `$.state`: «plain data that survives a hot reload of the plugin's code»).

test('a second session.start (what a reload of the plugin raises) leaves the tally and the row as they were', async ($, on) => {
  const w = world(on)
  w.roster.now = [agent('A', 'running'), agent('B', 'failed'), agent('C', 'completed')]
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 1   готово 1   сбой 1')
  await $.session.start(START)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 1   готово 1   сбой 1')
  // и после него учёт продолжает помнить: A пропал из списка -> готово
  w.roster.now = []
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 0   готово 2   сбой 1')
})

test('reload stand-in: a tally left in the session state by an earlier module instance is drawn at once and merged with the next read', async ($, on) => {
  const w = world(on)
  // Мир «после перезагрузки»: в state уже лежит учёт от прежнего экземпляра модуля, а у нового экземпляра в памяти
  // ничего нет. Заглушка подменяет значение в ответе на чтение ключа (версия остаётся той, что отдал тестовый
  // движок, а само чтение проходит через него, чтобы полоса подписалась на перерисовку), пока плагин ничего не
  // записал; после первой записи ответы идут как есть. Ответы завёрнуты в `{ value }`, как у остальных заглушек файла.
  let written = false
  on('state.set', { plugin: 'ctx', key: 'agents' }, (_$, e, next) => {
    written = true
    return next(e)
  })
  on('state.get', { plugin: 'ctx', key: 'agents' }, async (_$, e, next) => {
    const real = await next(e)
    return written ? real : { value: { value: { A: 'running', B: 'failed' }, version: real.value.version } }
  })
  const band = await desktopBand($, w)
  // ни одного чтения списка не было, а цифры уже те, что в state: 1 работает, 1 сбой
  expect(w.roster.reads).toBe(0)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 1   готово 0   сбой 1')
  // новое чтение: A в списке нет (работал -> готово), B нет (сбой остаётся), C новый
  w.roster.now = [agent('C', 'running')]
  await reread($)
  expect(await rowOf(band)).toBe(AGENTS + 'работают 1   готово 1   сбой 1')
})
