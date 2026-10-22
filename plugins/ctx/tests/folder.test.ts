import { test, expect, mock } from 'claude-code/testing'
import type { On, RenderSurface, SessionUsage } from 'claude-code'

// F-25: папка сессии в строке состояния приложения. Один шов: плагин целиком против подменённого
// движка (поверхности, корень и текущая папка сессии, переменные окружения); наблюдается то, что
// получил $.ui.status.
//
// Откуда ожидаемые строки (независимо от кода плагина):
//  - спека ctx 0.2.0 (.scratch/ctx-folder-agents/spec.md), «Implementation Decisions» -> «Короткое
//    имя папки»: примеры с домашней `/Users/anna` и Windows-пример переписаны оттуда дословно;
//  - строки группы `short name, by the rule` посчитаны руками по тому же правилу (разделители `/` и `\`
//    равноправны, пустые части отбрасываются, части склеиваются через `/`, две последние части, `~`
//    для домашней), но в спеке дословно не записаны: их сверит ревью, тест их лишь фиксирует;
//  - правило выбора строки — из той же спеки: все поверхности сессии — приложение -> строка состояния
//    = папка; иначе (терминал, телефон, VS Code рядом, или поверхности неизвестны) -> прежняя строка ctx.
//    Список наборов поверхностей для таблицы — из .superpowers/sdd/spec/task-1-observations.md (п. 4).
// Решения, которых в спеке нет, названы в тестах отдельно: имя начинается с `decision of the task`.

const START = { cwd: '/work', surface: 'desktop', isInteractive: false } as const
const CTX = '▪▫▫▫▫▫▫▫ 10%' // процент 10 -> round(10 / 100 * 8) = 1 деление из 8
const HOME = { HOME: '/Users/anna' }
const WIN = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\anna' }

const usageOf = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  startedAt: 0,
  context: { window: 200_000, percent: 10 },
  rateLimits: [],
  ...over,
})

type Place = {
  // значение — ответ движка; null — движок отказал (хук возвращает { deny })
  surfaces?: RenderSurface[] | null
  root?: string | null
  cwd?: string | null
  env?: Record<string, string> | null
  usage?: SessionUsage
}

// Мир под плагином: перехват $.ui.status, список поверхностей (его меняет тест по ходу), корень и текущая
// папка сессии, переменные окружения и «дно» для событий, которые плагин наблюдает. Заглушки стоят ниже
// проверяемого: короткое имя и выбор строки состояния считает сам плагин.
function world(on: On, place: Place = {}) {
  const { surfaces = ['desktop'], root = '/Users/anna/Desktop/CLAUDE/claude-kit', cwd = '/work', env = HOME, usage = usageOf() } = place
  const clock = mock.clock(on, { now: 1_000_000 })
  if (env === null) on('env.get', () => ({ deny: 'env refused' }))
  else mock.env(on, env)
  const shown: (string | undefined)[] = []
  // `whenRootAsked` — что происходит с миром в тот момент, когда плагин спрашивает у движка корень сессии (то есть
  // посреди перерисовки, после чтения поверхностей в старом порядке и до него в новом).
  const roster = { now: surfaces === null ? [] : [...surfaces], whenRootAsked: undefined as (() => void) | undefined }
  on('ui.status', (_$, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('session.surfaces', () => (surfaces === null ? { deny: 'surfaces refused' } : { value: [...roster.now] }))
  on('session.root', () => {
    roster.whenRootAsked?.()
    return root === null ? { deny: 'root refused' } : { value: root }
  })
  on('session.cwd', () => (cwd === null ? { deny: 'cwd refused' } : { value: cwd }))
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  return { clock, shown, roster, last: () => shown[shown.length - 1] }
}

// --- Короткое имя папки: примеры спеки дословно ---

const SPEC_EXAMPLES: [string, Record<string, string>, string][] = [
  ['/Users/anna/Desktop/CLAUDE/claude-kit', HOME, 'CLAUDE/claude-kit'],
  ['/Users/anna/Desktop', HOME, '~/Desktop'],
  ['/Users/anna', HOME, '~'],
  ['/tmp', HOME, '/tmp'],
  ['/', HOME, '/'],
  ['/srv/app/web', HOME, 'app/web'],
  ['C:\\Users\\anna\\proj\\web', WIN, 'proj/web'],
]
for (const [root, env, expected] of SPEC_EXAMPLES) {
  test(`short name, spec example: ${root} -> ${expected}`, async ($, on) => {
    const w = world(on, { root, env })
    await $.session.start(START)
    // одна отрисовка на старте сессии, и в строке состояния ровно это имя
    expect(w.shown).toEqual([expected])
  })
}

// --- Короткое имя: границы правила, посчитанные руками (по правилу спеки) ---

const BY_THE_RULE: [string, string, Record<string, string>, string][] = [
  ['exactly two parts below home are shown without ~', '/Users/anna/proj/web', HOME, 'proj/web'],
  ['a trailing slash is dropped: one part below home keeps ~/', '/Users/anna/Desktop/', HOME, '~/Desktop'],
  ['a trailing slash on home itself is still home', '/Users/anna/', HOME, '~'],
  ['empty parts (double slashes) are dropped', '/Users/anna//Desktop///CLAUDE', HOME, 'Desktop/CLAUDE'],
  ['home is a prefix by parts, not by letters: /Users/annabelle is outside /Users/anna', '/Users/annabelle/Desktop', HOME, 'annabelle/Desktop'],
  ['outside home with exactly two parts shows both without a leading slash', '/srv/app', HOME, 'srv/app'],
  ['outside home with one part shows the whole path', '/Users', HOME, '/Users'],
  ['Windows: one part below the profile keeps ~/', 'C:\\Users\\anna\\Desktop', WIN, '~/Desktop'],
  ['Windows: the profile itself is ~', 'C:\\Users\\anna', WIN, '~'],
  // Спека: «Домашняя папка — HOME, на Windows USERPROFILE»; отката с USERPROFILE на HOME она не называет. Здесь закреплено
  // решение задачи 1 (названо в её отчёте): на Windows без USERPROFILE домашняя неизвестна, даже если HOME есть
  // (в Git Bash он вида /c/Users/anna и с путём движка не совпал бы; для проверки взят вид Windows, чтобы совпадение
  // было возможно), и действует правило «вне домашней».
  ['Windows: no USERPROFILE and no fallback to HOME, home is unknown', 'C:\\Users\\anna\\Desktop', { OS: 'Windows_NT', HOME: 'C:\\Users\\anna' }, 'anna/Desktop'],
  ['Windows: USERPROFILE wins over a HOME of Git Bash form', 'C:\\Users\\anna\\Desktop', { ...WIN, HOME: '/c/Users/anna' }, '~/Desktop'],
  ['not Windows: HOME wins over a stray USERPROFILE', '/Users/anna/Desktop', { ...HOME, USERPROFILE: 'C:\\Users\\bob' }, '~/Desktop'],
  ['home unknown: the outside-home rule, two last parts', '/Users/anna/Desktop/CLAUDE/claude-kit', {}, 'CLAUDE/claude-kit'],
  ['home unknown: a folder that would be ~/Desktop shows two last parts', '/Users/anna/Desktop', {}, 'anna/Desktop'],
  ['home unknown: a folder that would be ~ shows two last parts', '/Users/anna', {}, 'Users/anna'],
  ['home unknown: a short path is shown whole', '/tmp', {}, '/tmp'],
  ['decision of the task: home empty string counts as unknown', '/Users/anna/Desktop', { HOME: '' }, 'anna/Desktop'],
  ['decision of the task: home "/" has no parts and counts as unknown, /tmp stays /tmp', '/tmp', { HOME: '/' }, '/tmp'],
  ['decision of the task: home "/" counts as unknown, /Users is not ~/Users', '/Users', { HOME: '/' }, '/Users'],
]
for (const [name, root, env, expected] of BY_THE_RULE) {
  test(`short name, by the rule: ${name}`, async ($, on) => {
    const w = world(on, { root, env })
    await $.session.start(START)
    expect(w.shown).toEqual([expected])
  })
}

test('decision of the task: a refused HOME read counts as home unknown (the outside-home rule), not as an error', async ($, on) => {
  const w = world(on, { root: '/Users/anna/Desktop', env: null })
  await $.session.start(START)
  expect(w.shown).toEqual(['anna/Desktop'])
})

// --- Откуда берётся папка ---

test('the folder comes from the session root, not from the current folder (a shell cd does not change it)', async ($, on) => {
  const w = world(on, { root: '/Users/anna/proj/web', cwd: '/tmp' })
  await $.session.start(START)
  expect(w.shown).toEqual(['proj/web'])
})

test('the engine refused the root: the current folder of the session is shown', async ($, on) => {
  const w = world(on, { root: null, cwd: '/Users/anna/Desktop' })
  await $.session.start(START)
  expect(w.shown).toEqual(['~/Desktop'])
})

// Решение таска (спека молчит): отказали и корень, и текущая папка — показывать нечего, строка состояния
// пустая (как раньше в приложении), а не строка шкал: ряд узкий для неё.
test('decision of the task: both the root and the current folder refused: the status line is empty, not the gauges', async ($, on) => {
  const w = world(on, { root: null, cwd: null })
  await $.session.start(START)
  expect(w.shown).toEqual([undefined])
})

// --- Кто владеет строкой состояния: полная таблица наборов поверхностей ---

const OWNERS: [RenderSurface[], 'folder' | 'ctx'][] = [
  [[], 'ctx'],
  [['desktop'], 'folder'],
  [['terminal'], 'ctx'],
  [['desktop', 'terminal'], 'ctx'],
  [['terminal', 'desktop'], 'ctx'],
  [['desktop', 'mobile'], 'ctx'],
  [['vscode'], 'ctx'],
  [['mobile'], 'ctx'],
  [['desktop', 'desktop'], 'folder'],
]
for (const [surfaces, owner] of OWNERS) {
  test(`surfaces ${JSON.stringify(surfaces)}: the status line is ${owner === 'folder' ? 'the folder' : 'the ctx line'}`, async ($, on) => {
    const w = world(on, { surfaces })
    await $.session.start(START)
    expect(w.shown).toEqual([owner === 'folder' ? 'CLAUDE/claude-kit' : CTX])
  })
}

test('the list of surfaces refused: the surfaces are unknown, the status line is the ctx line', async ($, on) => {
  const w = world(on, { surfaces: null })
  await $.session.start(START)
  expect(w.shown).toEqual([CTX])
})

test('the folder does not need ctx data: with nothing measured the app still shows the folder', async ($, on) => {
  const w = world(on, { usage: usageOf({ context: { window: 200_000 } }) })
  await $.session.start(START)
  expect(w.shown).toEqual(['CLAUDE/claude-kit'])
})

test('a terminal with nothing measured shows an empty status line, not a folder', async ($, on) => {
  const w = world(on, { surfaces: ['terminal'], usage: usageOf({ context: { window: 200_000 } }) })
  await $.session.start(START)
  expect(w.shown).toEqual([undefined])
})

// --- Переключение по ходу сессии ---

test('the app joining after the start gives the folder; a terminal joining takes the line back to ctx; the terminal leaving brings the folder back', async ($, on) => {
  const w = world(on, { surfaces: [] })
  await $.session.start(START)
  w.roster.now = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  w.roster.now = ['desktop', 'terminal']
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })
  w.roster.now = ['desktop']
  await $.session.detach({ surface: 'terminal', clientId: 'terminal:default' })
  w.roster.now = []
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(w.shown).toEqual([CTX, 'CLAUDE/claude-kit', CTX, 'CLAUDE/claude-kit', CTX])
})

// Порядок «сначала папка, потом поверхности» (см. draw в register.tsx): перерисовка выставляет строку состояния сразу
// за ответом о поверхностях. Заглушка корня сессии в тот момент, когда её спрашивают, подключает терминал: такая
// сессия больше не «только приложение», и в строке должна стоять строка ctx. Ожидание — из спеки (приложение +
// терминал -> строка ctx); если решение «одно приложение» принять по ответу о поверхностях, прочитанному до
// корня, в строке окажется папка, которую терминалу показывать нельзя.
test('a terminal joining while the folder is being read: the status line is the ctx line, not a folder decided from the older surfaces', async ($, on) => {
  const w = world(on)
  w.roster.whenRootAsked = () => {
    w.roster.now = ['desktop', 'terminal']
  }
  await $.session.start(START)
  expect(w.shown).toEqual([CTX])
})

test('a phone joining while the folder is being read: the same, the ctx line', async ($, on) => {
  const w = world(on)
  w.roster.whenRootAsked = () => {
    w.roster.now = ['desktop', 'mobile']
  }
  await $.session.start(START)
  expect(w.shown).toEqual([CTX])
})

test('the minute tick and a measurement keep the folder in an app-only session', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.advance(60_000)
  await $.session.measure({ context: { window: 200_000, percent: 62 }, rateLimits: [], changed: ['context' as const] })
  // start (1), minute tick (1), measure (1)
  expect(w.shown).toEqual(Array(3).fill('CLAUDE/claude-kit'))
})

// --- /clear и /resume ---

for (const reason of ['clear', 'resume'] as const) {
  test(`app only, session.end ${reason}: the folder stays in the status line at once and after the minute tick (the folder of the session is the same)`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.session.measure({ context: { window: 200_000, percent: 62 }, rateLimits: [], changed: ['context' as const] })
    const before = w.shown.length
    expect(await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
    // ровно одна перерисовка на сам сброс, и в ней папка, а не пустая строка
    expect(w.shown.slice(before)).toEqual(['CLAUDE/claude-kit'])
    // и ещё одна на минутный тик: таймер сброс переживает, папка по-прежнему на месте
    await w.clock.advance(60_000)
    expect(w.shown.slice(before)).toEqual(['CLAUDE/claude-kit', 'CLAUDE/claude-kit'])
  })

  test(`terminal only, session.end ${reason}: the status line is emptied, the folder is not shown`, async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.session.measure({ context: { window: 200_000, percent: 62 }, rateLimits: [], changed: ['context' as const] })
    expect(w.last()).toBe('🔴 ▪▪▪▪▪▫▫▫ 62%')
    const before = w.shown.length
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    expect(w.shown.slice(before)).toEqual([undefined])
  })
}

for (const reason of ['prompt_input_exit', 'logout', 'other'] as const) {
  test(`app only, session.end ${reason}: nothing is redrawn`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const before = w.shown.length
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    expect(w.shown.length).toBe(before)
    expect(w.last()).toBe('CLAUDE/claude-kit')
  })
}
