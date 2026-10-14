import { test, expect, mock } from 'claude-code/testing'
import type { On, RenderSurface, SessionRateLimit, SessionUsage } from 'claude-code'

// Строка ctx в приложении (вкладка Code) рисуется в полосе над полем ввода (AbovePrompt), а не
// строкой состояния: приложение 2.37337 ставит строку состояния плагина отдельным рядом под
// выбором модели, и мод не может вернуть её в ряд «Auto / Opus» (живая проба 2026-10-14, ledger).
// В терминале всё по-старому: строка состояния под полем ввода, полоса пустая.
// Подпись «ctx» в полосе ставит сам плагин: строку состояния подписывал движок (`ctx` в приложении,
// `⚠ ctx:` в терминале), а у полосы подписи нет — без неё строку не узнать (живая проверка 2026-10-14).
// Подпись отделена от строки тремя пробелами, как сегменты между собой.
// Ожидаемые строки — те же, что в status.test.ts (спека F-03...F-06, шкалы посчитаны руками:
// делений round(процент / 100 * 8) из 8: 10% -> 1, 62% -> 5).

const T0 = 1_000_000
const MIN = 60_000
const START = { cwd: '/work', surface: 'desktop', isInteractive: false } as const
const LABEL = 'ctx   '
const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 93, scroll: { offset: 0, bodyRows: 1 }, view: {} }

const usageOf = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  startedAt: 0,
  context: { window: 200_000 },
  rateLimits: [],
  ...over,
})

// Мир под плагином: часы, перехват $.ui.status, список поверхностей, который тест меняет
// по ходу (подключение и отключение клиентов), и «дно» для наблюдаемых событий.
function world(on: On, surfaces: RenderSurface[], usage: SessionUsage = usageOf()) {
  const clock = mock.clock(on, { now: T0 })
  const shown: (string | undefined)[] = []
  const roster = { now: [...surfaces] }
  on('ui.status', (_$, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: [...roster.now] }))
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  // То, что в полосе ниже нашего мода (опрос приложения или полосы других модов), с видимым текстом:
  // так тесты видят, что ctx его не съедает и ставит свою строку над ним.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.hasSurvey ? 'survey' : 'below'] })
  })
  return { clock, shown, roster, last: () => shown[shown.length - 1] }
}

const measureArg = (percent: number | undefined, rateLimits: SessionRateLimit[] = [], usd?: number) => ({
  context: percent === undefined ? { window: 200_000 } : { window: 200_000, percent },
  rateLimits,
  ...(usd === undefined ? {} : { cost: { usd } }),
  changed: ['context' as const],
})

const turnArg = { answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' as const }

// Весь текст полосы сверху вниз, через «|»; без строки ctx — только то, что ниже (`below` / `survey`).
const BELOW = '|below'
async function bandText(band: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  return (await band.findAll({ type: 'Text' })).map(t => t.text).join('|')
}

test('desktop: the line is drawn in the band above the prompt as one dim Text over what lies below, and the status line is cleared', async ($, on) => {
  const w = world(on, ['desktop'])
  await $.session.measure(measureArg(62, [{ kind: 'five_hour', percentUsed: 14 }], 1.84))
  expect(w.shown).toEqual([undefined])
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const texts = await band.findAll({ type: 'Text' })
  expect(texts.map(t => t.text)).toEqual([LABEL + '🔴 ▪▪▪▪▪▫▫▫ 62%   5ч ▪▫▫▫▫▫▫▫ 14%   $1.84', 'below'])
  expect(texts[0]!.props.dimColor).toBe(true)
})

test('terminal: the status line is drawn as before and the band shows nothing of ctx', async ($, on) => {
  const w = world(on, ['terminal'])
  await $.session.measure(measureArg(62))
  expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%')
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandText(band)).toBe('below')
})

test('no surfaces known (a -p run, or the app before it attached): the status line is kept', async ($, on) => {
  const w = world(on, [])
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
})

test('terminal and desktop together: the terminal keeps its status line, the desktop draws the band', async ($, on) => {
  const w = world(on, ['terminal', 'desktop'])
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await bandText(band)).toBe(LABEL + '▪▫▫▫▫▫▫▫ 10%' + BELOW)
})

test('desktop with a phone attached: the status line is kept, the phone has no band to show the line in', async ($, on) => {
  const w = world(on, ['desktop', 'mobile'])
  await $.session.measure(measureArg(10))
  expect(w.last()).toBe('▪▫▫▫▫▫▫▫ 10%')
})

test('the app attaching after the start clears the status line; detaching brings it back', async ($, on) => {
  const w = world(on, [], usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%'])
  w.roster.now = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%', undefined])
  w.roster.now = []
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(w.shown).toEqual(['▪▫▫▫▫▫▫▫ 10%', undefined, '▪▫▫▫▫▫▫▫ 10%'])
})

test('desktop: the band follows the cache timer minute by minute and goes cold at 5 min', async ($, on) => {
  const w = world(on, ['desktop'], usageOf({ context: { window: 200_000, percent: 10 } }))
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await bandText(band)).toBe(LABEL + '▪▫▫▫▫▫▫▫ 10%' + BELOW)
  await $.turn.complete(turnArg)
  expect(await bandText(band)).toBe(LABEL + '▪▫▫▫▫▫▫▫ 10%   кэш ◷ 0м' + BELOW)
  await w.clock.advance(MIN)
  expect(await bandText(band)).toBe(LABEL + '▪▫▫▫▫▫▫▫ 10%   кэш ◷ 1м' + BELOW)
  await w.clock.advance(4 * MIN)
  expect(await bandText(band)).toBe(LABEL + '▪▫▫▫▫▫▫▫ 10%   кэш остыл' + BELOW)
  // start, turn, tick at +1 min, ticks at +2..+4 min and the cold edge at +5 — every draw cleared the status line
  expect(w.shown.length).toBeGreaterThan(0)
  expect(w.shown.filter(line => line !== undefined)).toEqual([])
})

test('desktop: the band yields to a survey and draws again when it is gone', async ($, on) => {
  world(on, ['desktop'])
  await $.session.measure(measureArg(10))
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  expect(await bandText(band)).toBe('survey')
  await band.redraw(BAND)
  expect(await bandText(band)).toBe(LABEL + '▪▫▫▫▫▫▫▫ 10%' + BELOW)
})

test('desktop: nothing known draws no band', async ($, on) => {
  world(on, ['desktop'])
  await $.session.measure(measureArg(undefined))
  const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await bandText(band)).toBe('below')
})

for (const reason of ['clear', 'resume'] as const) {
  test(`desktop: session.end ${reason} empties the band at once`, async ($, on) => {
    world(on, ['desktop'])
    await $.session.measure(measureArg(62))
    const band = await $.ui.mount({ plugin: 'ctx', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await bandText(band)).toBe(LABEL + '🔴 ▪▪▪▪▪▫▫▫ 62%' + BELOW)
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    expect(await bandText(band)).toBe('below')
  })
}
