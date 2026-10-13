import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, ProcessRunResult, RenderSurface } from 'claude-code'
import * as L from '../hooks/logic'

// Откуда ожидаемые значения (независимо от кода register.ts):
//  - вход теста: время 2026-10-08 09:05:07 по местному времени (метка 2026-10-08-090507), корень /r из
//    подменённого `git rev-parse`, папка docs/handoffs (ни одного кандидата F-10 нет), цепочка `t` seq `2`;
//  - спека F-15…F-23 и бриф Task 8: «Контекст N%. Передать работу в новую сессию?», «Передать» / «Не сейчас»
//    (F-15), «Хендофф не записан — ничего не закрыто» (F-17), «Новая сессия не открылась сама … Фраза скопирована:
//    нажми ⌘N (Windows: Ctrl+N) и вставь» в приложении, «… открой новое окно терминала, запусти claude в папке
//    проекта и вставь» в терминале, «… открой новую сессию Claude Code в папке проекта и вставь» в остальных
//    местах (F-21 в редакции после финального ревью, пункт 1; формулировки даны в брифе фикса, ключи по ОС),
//    «Передача уже идёт: <путь>» (бриф, случай 9), «Хендофф не дождались —
//    ничего не закрыто» (бриф, случай 11: спека F-17 даёт один текст «не записан» и для тайм-аута, бриф разводит
//    их, тест следует брифу), «путь содержит символы, которые искажает консоль Windows» (наблюдения контроллера);
//  - причины в скобках после «не открылась сама»: «окно терминала не открылось», «чат не появился за 60 с»,
//    «фоновый запуск: …», «Windows: проверить появление чата нельзя» — из кода брифа;
//  - фразы без формулировки в спеке и в брифе (решения реализации, их сверит ревью, тест лишь фиксирует): «Пишу
//    хендофф; потом коммит и новая сессия» (из кода брифа, в спеке нет), «Передача уже запускается», причины «не
//    удалось сделать файл запуска исполняемым», «не удалось открыть ссылку на чат», «не найден HOME», «Хендофф не
//    запустился (…)», «Новая сессия открыта, но закрыть эту не вышло (…)», «Передача оборвалась (…): …»,
//    «Команда /handoff-now не зарегистрирована (…)»;
//  - ответ контроллера по ревью (раунд фиксов 1): «Передача остановлена — ничего не закрыто», причина «передача
//    прервалась» (и то и другое дословно из его указаний); причина про поверхности «открыть окно можно только из
//    терминала или приложения (поверхности: …)» и «непонятный ответ (…)» / «код N» для фонового запуска — решения
//    реализации (в указаниях сказано только «причина в тосте»);
//  - окно ожидания 15 мин, 60 с на чат приложения, 30 суток хранения: спека F-17, F-20, F-23;
//  - описание команды «Передать работу в новую сессию сейчас» — из кода брифа Task 8 (в спеке его нет); команда
//    регистрируется и в неинтерактивной сессии, а метка передачи в такой сессии доводится на первом session.attach —
//    указание контроллера по живой проверке в приложении (бриф Task 9 live-fix); спека F-23 пока говорит «на session.start»;
//  - `argv` для запуска: сами сборщики L.windowsArgv / L.macCommandScript / L.pastePrompt проверены в logic.test.ts,
//    здесь они только считают ожидаемое по входам теста.
// Мир под плагином: подменены только существительные ниже него ($.process, $.fs, $.ui, $.store, $.session.id…,
// часы и среда). Логика плагина (L.*) не подменяется. Хранилище написано вручную, а не через mock.store, чтобы
// тест мог читать ключи обратно.

const T0 = new Date(2026, 9, 8, 9, 5, 7).getTime()
const MIN = 60_000
const WAIT = 15 * MIN
const DAY = 24 * 60 * MIN
const SID = 'sid-1'
const PATH = '/r/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
const CHAIN = { tag: 't', seq: 2 }
const NOTE = 'Цель\n**Chain:** `t` seq `2`\nдальше'
const PROMPT = L.pastePrompt(PATH, CHAIN)
const START = { cwd: '/r/sub', surface: 'terminal', isInteractive: true } as const
// Сессия приложения идёт через SDK: isInteractive: false, поверхности при старте нет, клиент подключается позже
// (session.attach). Голый `claude -p` стартует так же, но не подключается никогда.
const APP_START = { cwd: '/r', surface: null, isInteractive: false } as const
const ATTACH = { surface: 'desktop', clientId: 'desktop:default' } as const
const DESCRIPTION = 'Передать работу в новую сессию сейчас'
const HOME = '/Users/u'
const APP = `${HOME}/Library/Application Support/Claude/claude-code-sessions`
const DECOY = '00000000-0000-4000-8000-000000000000'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Окончания подсказки запасного пути А по месту, где идёт сессия (эталон — F-21 в спеке, не register.ts).
const ENDING = {
  appMac: 'нажми ⌘N и вставь',
  appWin: 'нажми Ctrl+N и вставь',
  terminal: 'открой новое окно терминала, запусти claude в папке проекта и вставь',
  other: 'открой новую сессию Claude Code в папке проекта и вставь',
}
const FALLBACK = (why: string, ending = ENDING.terminal) =>
  `Новая сессия не открылась сама (${why}). Фраза скопирована: ${ending}`
// Вариант без буфера обмена: фраза целиком в тосте и в журнале, подсказка с большой буквы, перед фразой двоеточие.
const NOCLIP = {
  appMac: 'Нажми ⌘N и вставь',
  appWin: 'Нажми Ctrl+N и вставь',
  terminal: 'Открой новое окно терминала, запусти claude в папке проекта и вставь',
  other: 'Открой новую сессию Claude Code в папке проекта и вставь',
}
const NOCLIP_TEXT = (why: string, lead: string) => `Новая сессия не открылась сама (${why}). ${lead}: ${PROMPT}`

type WorldOpts = {
  surfaces?: RenderSurface[]
  env?: Record<string, string>
  cwd?: string // что отвечает $.session.cwd()
  root?: string // что отвечает $.session.root(); по умолчанию то же, что cwd
  git?: string | null // что печатает git rev-parse; null — «не репозиторий»
  dirs?: string[]
  store?: Record<string, unknown>
  wt?: boolean // `where wt` находит Windows Terminal
  proc?: (argv: readonly string[]) => Partial<ProcessRunResult> | undefined
  skill?: 'ok' | 'rejects'
  exit?: 'ok' | 'rejects'
}

function world(on: On, opts: WorldOpts = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, opts.env ?? {})
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const files = new Map<string, number>()
  const texts = new Map<string, string>()
  const dirs = new Set<string>(opts.dirs ?? [])
  files.set(`${APP}/acct1/org1/local_${DECOY}.json`, 1)
  let gate: Promise<void> | null = null
  let open = () => {}
  let startGate: Promise<void> | null = null
  let startOpen = () => {}
  let skillGate: Promise<boolean> | null = null
  let skillOpen: (fails: boolean) => void = () => {}
  const w = {
    clock,
    store,
    files,
    texts,
    surfaces: (opts.surfaces ?? ['terminal']) as RenderSurface[],
    answers: [] as (string | null)[],
    asked: [] as { question: string; options: string[] }[],
    commands: [] as { command: string; args: string }[],
    procs: [] as { argv: string[]; init: { cwd?: string; stdin?: string; timeoutMs?: number } | undefined; keys: string[] }[],
    writes: [] as { path: string; text: string }[],
    toasts: [] as string[],
    copies: [] as string[],
    logs: [] as string[],
    registered: [] as { name: string; description: string }[],
    attached: [] as string[], // клиенты, чьё подключение дошло до «дна» цепочки session.attach (то есть мод вызвал next)
    effects: [] as string[],
    listed: 0,
    copyOk: true,
    copyRejects: false,
    storeFails: false,
    registerFails: false,
    surfacesFail: false,
    rootFails: false, // $.session.root() отклонён
    sid: SID as string, // что отвечает $.session.id(); тест меняет его, как /clear
    seedId: undefined as string | undefined,
    openedAt: undefined as number | undefined,
    appRecordAfterMs: undefined as number | undefined,
    hold: () => { gate = new Promise<void>(r => { open = r }) },
    release: () => { open(); gate = null },
    // session.start повисает на чтении id сессии, пока его не отпустят: id ещё не известен, старт ещё идёт.
    holdStart: () => { startGate = new Promise<void>(r => { startOpen = r }) },
    releaseStart: () => { startOpen(); startGate = null },
    // Запуск скилла handoff:handoff повисает, пока его не отпустят: либо с успехом, либо с отказом.
    holdSkill: () => { skillGate = new Promise<boolean>(r => { skillOpen = r }) },
    releaseSkill: (fails: boolean) => { skillOpen(fails); skillGate = null },
    skillRuns: () => w.commands.filter(c => c.command === 'handoff:handoff'),
    keys: () => [...store.keys()].sort(),
  }
  const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

  // События, которые плагин только пропускает дальше: без «дна» вызов падает.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.attach', (_$, e) => { w.attached.push(e.clientId); return { clientId: e.clientId } })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  on('session.id', async () => {
    if (startGate) await startGate
    return { value: w.sid }
  })
  on('session.cwd', () => ({ value: opts.cwd ?? '/r/sub' }))
  on('session.root', () => (w.rootFails ? { deny: 'no root' } : { value: opts.root ?? opts.cwd ?? '/r/sub' }))
  on('session.surfaces', () => (w.surfacesFail ? { deny: 'no roster' } : { value: [...w.surfaces] }))
  on('command.register', (_$, e) => {
    if (w.registerFails) return { deny: 'name taken' }
    w.registered.push({ name: e.name, description: e.description })
    return { value: { command: e.name } }
  })

  on('store.get', (_$, e) => ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }))
  on('store.set', (_$, e) => {
    if (w.storeFails) return { deny: 'disk full' }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))

  // Тест идёт на Mac, а путь вида C:/proj для него относительный: движок дописывает к нему папку плагина.
  // Диск подменён, поэтому приводим такой путь обратно к виду, в котором мод его назвал.
  const named = (path: string) => path.replace(/^.*?\/([A-Za-z]:\/)/, '$1')
  on('fs.stat', (_$, e) => {
    const path = named(e.path)
    const m = files.get(path)
    if (m !== undefined) return { value: { kind: 'file', size: 1, mtimeMs: m, isLink: false } }
    if (dirs.has(path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    const rec = /\/local_([^/]+)\.json$/.exec(path)
    if (
      rec && rec[1] === w.seedId && path === `${APP}/acct1/org1/local_${w.seedId}.json` &&
      w.openedAt !== undefined && w.appRecordAfterMs !== undefined && clock.now() >= w.openedAt + w.appRecordAfterMs
    ) return { value: { kind: 'file', size: 1, mtimeMs: clock.now(), isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('fs.read', (_$, e) => (texts.has(named(e.path)) ? { value: texts.get(named(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => { w.writes.push({ path: named(e.path), text: e.text }); w.effects.push('write'); return { value: undefined } })
  on('fs.list', (_$, e) => {
    w.listed++
    const entry = (name: string, kind: FsEntry['kind']): FsEntry => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === APP) return { value: [entry('acct0', 'dir'), entry('stray.txt', 'file'), entry('acct1', 'dir')] }
    if (e.path === `${APP}/acct0`) return { value: [] }
    if (e.path === `${APP}/acct1`) return { value: [entry('notes.txt', 'file'), entry('org1', 'dir')] }
    return { deny: 'ENOENT' }
  })

  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    w.procs.push({ argv, init: e.init, keys: [...store.keys()].sort() })
    w.effects.push(`proc:${argv[0]}`)
    if (argv[0] === 'git') {
      const git = opts.git === null ? { ...ok, exitCode: 128, stderr: 'fatal: not a git repository' } : { ...ok, stdout: `${opts.git ?? '/r'}\n` }
      return { value: { ...git, ...opts.proc?.(argv) } }
    }
    if (argv[0] === 'where') return { value: { ...ok, exitCode: opts.wt ? 0 : 1 } }
    if (argv.includes('--session-id')) w.seedId = argv[argv.indexOf('--session-id') + 1]
    if ((argv[0] === 'open' && String(argv[1]).startsWith('claude://')) || argv[0] === 'rundll32') w.openedAt = clock.now()
    // вывод `claude -p --output-format json` при успехе
    const seed = argv.includes('--session-id')
      ? { stdout: `{"type":"result","subtype":"success","is_error":false,"session_id":"${w.seedId}","result":"Пересказ готов"}` }
      : {}
    return { value: { ...ok, ...seed, ...opts.proc?.(argv) } }
  })

  on('ui.toast', (_$, e) => { w.toasts.push(e.text); w.effects.push('toast'); return { value: undefined } })
  on('ui.log', (_$, e) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.copy', (_$, e) => {
    w.copies.push(e.text)
    w.effects.push('copy')
    if (w.copyRejects) return { deny: 'no clipboard tool' }
    return { value: w.copyOk ? { isCopied: true as const } : { isCopied: false as const, reason: 'no-clipboard' as const } }
  })
  // $.ui.ask — это tool.call инструмента AskUserQuestion (types: UiApi.ask); ответ — подпись выбранной кнопки.
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const q = e.questions[0]!
    w.asked.push({ question: q.question, options: q.options.map(o => o.label) })
    if (gate) await gate
    const a = w.answers.length > 0 ? w.answers.shift()! : 'Не сейчас'
    if (a === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: a } } }
  })
  const bottom = (e: { command: string; args: string }) => {
    w.commands.push({ command: e.command, args: e.args })
    w.effects.push(`cmd:${e.command}`)
    return {}
  }
  if (opts.skill !== 'rejects') {
    on('command.run', { command: 'handoff:handoff' }, async (_$, e) => {
      if (skillGate && (await skillGate)) throw new Error('late failure')
      return bottom(e)
    })
  }
  if (opts.exit !== 'rejects') on('command.run', { command: 'exit' }, (_$, e) => bottom(e))

  return w
}
type World = ReturnType<typeof world>

const measureArg = (percent: number | undefined) => ({
  context: percent === undefined ? { window: 200_000 } : { window: 200_000, percent },
  rateLimits: [],
  changed: ['context' as const],
})
const turnDone = (turnId: string, agentId?: string, isAborted = false) => ({
  answer: '',
  durationMs: 1,
  isAborted,
  turnId,
  reason: isAborted ? ('aborted' as const) : ('answer' as const),
  ...(agentId ? { agentId } : {}),
})

// Команда, набранная человеком: args, origin и presentation движок заполняет сам.
const typed = ($: Engine, command: string) =>
  $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

// Старт сессии, контекст ровно на пороге по умолчанию (50%), ответ «Передать»: скилл запущен, мод ждёт файл.
async function begin($: Engine, w: World) {
  w.answers.push('Передать')
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
}
// Ход, который пишет хендофф, закончился; файл (если mtimeMs задан) появился через 5 с после начала.
async function writeTurn($: Engine, w: World, o: { turnId?: string; mtimeMs?: number | null; path?: string } = {}) {
  const path = o.path ?? PATH
  const turnId = o.turnId ?? 'w1'
  await $.turn.start({ text: `/handoff:handoff auto ${path}`, turnId })
  if (o.mtimeMs !== null) {
    w.files.set(path, o.mtimeMs ?? T0 + 5000)
    w.texts.set(path, NOTE)
  }
  await w.clock.advance(5000)
  await $.turn.complete(turnDone(turnId))
  await w.clock.settle()
}

// ---------- 1-2. вопрос на пороге (F-15) ----------

test('F-15/F-24 case 1 (default settings): 49% is quiet, 50% asks once with the exact question and the two answers', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(49))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toEqual([{ question: 'Контекст 50%. Передать работу в новую сессию?', options: ['Передать', 'Не сейчас'] }])
})

// Порог сравнивается с округлённым процентом, как строка ctx и текст вопроса (решение пользователя: 🔴 и вопрос вместе).
test('F-15 rounding (default 50): 49.4% is quiet, 49.5% asks with «Контекст 50%»', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(49.4))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(49.5))
  await w.clock.settle()
  expect(w.asked.map(a => a.question)).toEqual(['Контекст 50%. Передать работу в новую сессию?'])
})

test('F-15 rounding (default 50): 49.6% asks at once with «Контекст 50%»', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(49.6))
  await w.clock.settle()
  expect(w.asked.map(a => a.question)).toEqual(['Контекст 50%. Передать работу в новую сессию?'])
})

test('F-15 rounding, options { threshold: 60 }: 59.4% is quiet, 59.5% asks with «Контекст 60%»', { options: { threshold: 60 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(59.4))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(59.5))
  await w.clock.settle()
  expect(w.asked.map(a => a.question)).toEqual(['Контекст 60%. Передать работу в новую сессию?'])
})

test('F-15 rounding: after the handoff was launched 49.6% (shown as 50%) does not re-arm the question, 49.4% does', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w)
  expect(w.effects).toContain('cmd:exit')
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(49.6))
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1) // 49.6 округляется до 50: порог не пройден вниз, вопрос остаётся снятым
  await $.session.measure(measureArg(49.4))
  await $.session.measure(measureArg(49.5))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2) // 49.4 (округляется до 49) взвёл вопрос, 49.5 (до 50) задал его
  expect(w.asked[1]!.question).toBe('Контекст 50%. Передать работу в новую сессию?')
})

test('F-24: options { threshold: 60 } (the old default, now explicit) is honoured: 59% is quiet, 60% asks', { options: { threshold: 60 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await $.session.measure(measureArg(59))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(60))
  await w.clock.settle()
  expect(w.asked.map(a => a.question)).toEqual(['Контекст 60%. Передать работу в новую сессию?'])
})

test('F-15: no reading of the context yet (no percent) means no question', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(undefined))
  await w.clock.settle()
  expect(w.asked).toEqual([])
})

test('F-15: a session with no surface (claude -p) is not asked; later, with a surface, the question comes', async ($, on) => {
  const w = world(on, { surfaces: [] })
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  w.surfaces = ['terminal']
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-15 case 2: «Не сейчас» at 50 → silent at 59, asks again at 60', async ($, on) => {
  const w = world(on)
  w.answers.push('Не сейчас')
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(59))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(60))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('F-15: «Не сейчас» twice: 50 → 60 → 70 (69 silent, 70 asks)', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const pct of [50, 60]) {
    await $.session.measure(measureArg(pct))
    await w.clock.settle()
  }
  expect(w.asked).toHaveLength(2)
  await $.session.measure(measureArg(69))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  await $.session.measure(measureArg(70))
  await w.clock.settle()
  expect(w.asked).toHaveLength(3)
})

test('F-15: a jump over the threshold asks with the real percent and snoozes from it (83 → next at 93)', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(83))
  await w.clock.settle()
  expect(w.asked.map(a => a.question)).toEqual(['Контекст 83%. Передать работу в новую сессию?'])
  await $.session.measure(measureArg(92))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(93))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('F-15: a dismissed question counts as «Не сейчас» (next at 60)', async ($, on) => {
  const w = world(on)
  w.answers.push(null)
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  await $.session.measure(measureArg(59))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(60))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('F-15: a free-text answer («Other») is not «Передать» and snoozes too', async ($, on) => {
  const w = world(on)
  w.answers.push('позже')
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.skillRuns()).toHaveLength(0)
  await $.session.measure(measureArg(59))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-24: options { step: 0 } → second ask at 51 (clamped), not at 50', { options: { step: 0 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(51))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('F-24: options { threshold: 150 } is clamped to 100: silent at 99, asks at 100', { options: { threshold: 150 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(99))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(100))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-24: options { threshold: 40, step: 5 }: asks at 40, «Не сейчас» → next at 45', { options: { threshold: 40, step: 5 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(39))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(40))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(44))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(45))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('F-15 race: two measurements at 50 delivered back-to-back while the question is open → one question', async ($, on) => {
  const w = world(on)
  w.hold()
  await $.session.start(START)
  await Promise.all([$.session.measure(measureArg(50)), $.session.measure(measureArg(50))])
  await w.clock.settle()
  await $.session.measure(measureArg(55))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  w.release()
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  // ответ получен («Не сейчас» → порог 60): флаг «спрашиваю» снят, дальше вопрос возможен
  await $.session.measure(measureArg(60))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

// ---------- 3. запуск скилла ----------

test('F-17 case 3: «Передать» runs handoff:handoff with auto <root>/docs/handoffs/HANDOFF_auto_<stamp>.md', async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(w.commands).toEqual([{ command: 'handoff:handoff', args: `auto ${PATH}` }])
  // корень взят из git (/r), а не из cwd сессии (/r/sub)
  expect(w.procs[0]!.argv).toEqual(['git', '-C', '/r/sub', 'rev-parse', '--show-toplevel'])
})

test('F-23: the start is written to the store: pending under p:<id>, trigger under t:<id>', async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(w.store.get(`p:${SID}`)).toEqual({ path: PATH, startedAt: T0, root: '/r', writeTurnId: null })
  expect(w.store.get(`t:${SID}`)).toEqual({ askAt: 50, armed: false, at: T0 })
  expect(w.keys()).toEqual([`p:${SID}`, `t:${SID}`])
})

test('F-10: the folder follows the first existing candidate; a plain file with that name does not count', async ($, on) => {
  const w = world(on, { dirs: ['/r/plans/handoffs', '/r/docs/handoffs'] })
  w.files.set('/r/docs/superpowers/handoffs', 1)
  await begin($, w)
  expect(w.commands[0]!.args).toBe('auto /r/plans/handoffs/HANDOFF_auto_2026-10-08-090507.md')
})

test('F-10: no candidate, but docs/superpowers exists → docs/superpowers/handoffs', async ($, on) => {
  const w = world(on, { dirs: ['/r/docs/superpowers'] })
  await begin($, w)
  expect(w.commands[0]!.args).toBe('auto /r/docs/superpowers/handoffs/HANDOFF_auto_2026-10-08-090507.md')
})

test('F-10: Windows cwd with backslashes and no git → the root is the cwd with forward slashes', async ($, on) => {
  const w = world(on, { git: null, cwd: 'C:\\proj\\sub' })
  await begin($, w)
  expect(w.commands[0]!.args).toBe('auto C:/proj/sub/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md')
  expect(w.procs[0]!.argv).toEqual(['git', '-C', 'C:\\proj\\sub', 'rev-parse', '--show-toplevel']) // git получает cwd как есть
})

test('F-10: git fails with some output on stdout → still not a repository, the cwd is the root', async ($, on) => {
  const w = world(on, { proc: argv => (argv[0] === 'git' ? { exitCode: 1, stdout: '/wrong\n' } : undefined) })
  await begin($, w)
  expect(w.commands[0]!.args).toBe('auto /r/sub/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md')
})

test('F-10: not a git repository → <cwd>/docs/handoffs, whatever folders exist', async ($, on) => {
  const w = world(on, { git: null, dirs: ['/r/sub/plans/handoffs', '/r/sub/docs/superpowers'] })
  await begin($, w)
  expect(w.commands[0]!.args).toBe('auto /r/sub/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md')
  expect(w.store.get(`p:${SID}`)).toEqual({ path: '/r/sub/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md', startedAt: T0, root: '/r/sub', writeTurnId: null })
})

// ---------- F-10: корень проекта = корень сессии от движка, а не текущая папка (живая ошибка 2026-10-11…13) ----------
//
// Источник ожиданий: вход теста и спека F-10 в редакции этого исправления (проект — корень сессии, `$.session.root()`;
// `cd` оболочки во время работы его не двигает), документация движка к `$.session.root()` в claude-code.d.ts («A shell
// `cd` during the session does not move it»), F-18/F-19 (`cd <корень>`, `wt -d <корень>`, `/D <корень>`), F-20 (запуск
// в корне). Живой случай: сессия открыта в общей папке (не репозиторий), агент сделал `cd nested-repo` (вложенный
// репозиторий), `$.session.cwd()` стал `…/nested-repo`, и хендофф лёг в него. Здесь та же форма: корень сессии /r (не
// репозиторий), текущая папка /r/sub (репозиторий сам по себе). Тесты ниже — единственное место, где корень и текущая
// папка в мире различаются; во всех остальных тестах root() отвечает то же, что cwd().

// git по папкам: `git -C <папка> rev-parse` печатает указанный корень; для остальных папок остаётся ответ мира
// (при `git: null` — «не репозиторий», код 128).
const gitIn = (tops: Record<string, string>) => (argv: readonly string[]) =>
  argv[0] === 'git' && argv[2] !== undefined && argv[2] in tops ? { exitCode: 0, stdout: `${tops[argv[2]]}\n`, stderr: '' } : undefined
const SUB_REPO = gitIn({ '/r/sub': '/r/sub' })
const GIT_AT_R = ['git', '-C', '/r', 'rev-parse', '--show-toplevel']
// Мир задачи: корень сессии /r (не git), оболочка ушла в /r/sub, где rev-parse удался бы с /r/sub.
const movedShell = (on: On, extra: WorldOpts = {}) => world(on, { git: null, cwd: '/r/sub', root: '/r', proc: SUB_REPO, ...extra })

test('F-10 session root: root is /r (not a git repo), the shell moved to /r/sub (a repo of its own) → handoff in /r/docs/handoffs, the Mac window cds into /r', async ($, on) => {
  const w = movedShell(on)
  await $.session.start(START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.procs.map(p => p.argv)).toEqual([GIT_AT_R])
  expect(w.commands).toEqual([{ command: 'handoff:handoff', args: `auto ${PATH}` }])
  expect(w.store.get(`p:${SID}`)).toEqual({ path: PATH, startedAt: T0, root: '/r', writeTurnId: null })
  await writeTurn($, w)
  expect(w.writes).toEqual([{ path: '/tmp/claude-kit-handoff-2026-10-08-090507.command', text: L.macCommandScript('/r', 'claude', PROMPT) }])
  expect(w.writes[0]!.text.split('\n')[1]).toBe("cd '/r' || exit 1") // строка pinned в logic.test.ts; здесь важен корень /r
  expect(w.effects).toContain('cmd:exit')
})

test('F-10 session root: the same in the desktop app → the background chat starts in /r', async ($, on) => {
  const w = movedShell(on, { surfaces: ['desktop'], env: { HOME } })
  w.appRecordAfterMs = 2000
  await $.session.start(APP_START)
  await $.session.attach(ATTACH)
  await typed($, 'handoff-now')
  await w.clock.settle()
  await writeTurn($, w)
  expect(seedArgs(w).init!.cwd).toBe('/r')
  expect(w.toasts).toEqual([])
})

const windowsCase = (hasWt: boolean) => async ($: Engine, on: On) => {
  const w = movedShell(on, { env: { OS: 'Windows_NT' }, wt: hasWt })
  await $.session.start(START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  await writeTurn($, w)
  const argv = w.procs[w.procs.length - 1]!.argv
  expect(argv).toEqual(L.windowsArgv(hasWt, '/r', 'claude', L.windowsPrompt(PROMPT)))
  // Форма из спеки F-19: `wt -d <корень> …` и `cmd /c start "" /D <корень> …`.
  expect(argv.slice(0, hasWt ? 3 : 6)).toEqual(hasWt ? ['wt', '-d', '/r'] : ['cmd', '/c', 'start', '', '/D', '/r'])
}
test('F-10 session root: the same on Windows with wt → wt -d /r', windowsCase(true))
test('F-10 session root: the same on Windows without wt → cmd /c start "" /D /r', windowsCase(false))

test('F-10 session root: repo /g, the shell later in /g/pkg → git is asked about /g and the root is /g (unchanged result)', async ($, on) => {
  const w = world(on, { cwd: '/g/pkg', root: '/g', git: '/g' })
  await $.session.start(START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.procs.map(p => p.argv)).toEqual([['git', '-C', '/g', 'rev-parse', '--show-toplevel']])
  expect(w.commands).toEqual([{ command: 'handoff:handoff', args: 'auto /g/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md' }])
  expect(w.store.get(`p:${SID}`)).toEqual({ path: '/g/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md', startedAt: T0, root: '/g', writeTurnId: null })
})

test('F-10 session root: the session root is a sub-folder of a repo → the root is the repo top (git toplevel of the session root)', async ($, on) => {
  const w = world(on, { cwd: '/elsewhere', root: '/g/pkg', proc: gitIn({ '/g/pkg': '/g' }) })
  await $.session.start(START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.procs.map(p => p.argv)).toEqual([['git', '-C', '/g/pkg', 'rev-parse', '--show-toplevel']])
  expect(w.commands[0]!.args).toBe('auto /g/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md')
})

test('F-10 session root, /clear: the session id changes to sid-2, a new session.start comes from /r/sub, root() still says /r → the root stays /r', async ($, on) => {
  const w = movedShell(on)
  await $.session.start({ ...START, cwd: '/r' })
  w.sid = 'sid-2' // /clear: новый id сессии
  await $.session.start(START) // перезапуск мода: теперь событие приходит уже из /r/sub
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.procs.map(p => p.argv)).toEqual([GIT_AT_R])
  expect(w.commands).toEqual([{ command: 'handoff:handoff', args: `auto ${PATH}` }])
  expect(w.store.get('p:sid-2')).toEqual({ path: PATH, startedAt: T0, root: '/r', writeTurnId: null })
  expect(w.keys()).toEqual(['p:sid-2', 't:sid-2']) // кроме меток передачи и вопроса, в хранилище ничего нет
})

test('F-10 session root: root() is refused → the handoff falls back to the current folder of the session', async ($, on) => {
  const w = world(on, { git: null, cwd: '/q/work', root: '/r' })
  w.rootFails = true
  await $.session.start(START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.procs.map(p => p.argv)).toEqual([['git', '-C', '/q/work', 'rev-parse', '--show-toplevel']])
  expect(w.commands[0]!.args).toBe('auto /q/work/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md')
  expect(w.toasts).toEqual([])
})

test('F-10 session root: the folder of the session.start event does not matter, session.start writes nothing about it to the store', async ($, on) => {
  const w = movedShell(on)
  await $.session.start({ ...START, cwd: '/somewhere/else' })
  expect(w.keys()).toEqual([])
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.procs.map(p => p.argv)).toEqual([GIT_AT_R])
})

// ---------- 4. хендофф не записан ----------

test('F-17 case 4: an old file is not a written handoff: toast, nothing launched, nothing closed', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w, { mtimeMs: T0 - 60_000 })
  expect(w.toasts).toEqual(['Хендофф не записан — ничего не закрыто'])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'toast'])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
  expect(w.keys()).toEqual([`t:${SID}`]) // метка передачи снята
})

test('F-17: the write turn ended and there is no file at all: same toast, nothing closed', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w, { mtimeMs: null })
  expect(w.toasts).toEqual(['Хендофф не записан — ничего не закрыто'])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'toast'])
})

test('F-17 boundary: file 2 s older than the start counts as written (mtime = start - 2000), 2.001 s older does not', async ($, on) => {
  const ok = world(on)
  await begin($, ok)
  await writeTurn($, ok, { mtimeMs: T0 - 2000 })
  expect(ok.toasts).toEqual([])
  expect(ok.effects).toContain('proc:open')
})
test('F-17 boundary: mtime = start - 2001 is an old file', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w, { mtimeMs: T0 - 2001 })
  expect(w.toasts).toEqual(['Хендофф не записан — ничего не закрыто'])
  expect(w.effects).not.toContain('proc:open')
})

test('F-15: after a cancelled handoff the question is armed again (a stale file at 75% → asked again at once)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w, { mtimeMs: T0 - 60_000 })
  await $.session.measure(measureArg(75))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('F-17: the end of an unrelated turn does not cancel, the end of a subagent turn does not launch', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `/handoff:handoff auto ${PATH}`, turnId: 'w1' })
  await $.turn.complete(turnDone('other'))
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  w.files.set(PATH, T0 + 5000)
  w.texts.set(PATH, NOTE)
  await $.turn.complete(turnDone('w1', 'agent-7'))
  await w.clock.settle()
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff'])
  expect(w.toasts).toEqual([])
  // а ход главной сессии с файлом на месте запускает новую сессию
  await $.turn.complete(turnDone('w1'))
  await w.clock.settle()
  expect(w.effects).toContain('proc:open')
})

test('F-17 boundary: a turn ends exactly 15 min after the start with no file → still waiting; 1 ms later → timeout', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await w.clock.advance(WAIT)
  await $.turn.complete(turnDone('other'))
  expect(w.toasts).toEqual([])
  await w.clock.advance(1)
  await $.turn.complete(turnDone('other'))
  expect(w.toasts).toEqual(['Хендофф не дождались — ничего не закрыто'])
})

test('F-17: only the first turn that names the path is the write turn (a later one quoting it does not take over)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `/handoff:handoff auto ${PATH}`, turnId: 'w1' })
  await $.turn.start({ text: `что в ${PATH}?`, turnId: 'w2' })
  await $.turn.complete(turnDone('w2'))
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.keys()).toContain(`p:${SID}`)
  expect((w.store.get(`p:${SID}`) as { writeTurnId: string }).writeTurnId).toBe('w1')
})

test('F-17/MED-2: the write turn is interrupted after the file was written → cancelled, no window, no exit', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `/handoff:handoff auto ${PATH}`, turnId: 'w1' })
  w.files.set(PATH, T0 + 5000)
  w.texts.set(PATH, NOTE)
  await $.turn.complete(turnDone('w1', undefined, true))
  await w.clock.advance(60_000)
  expect(w.toasts).toEqual(['Передача остановлена — ничего не закрыто'])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'toast'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-17/MED-2: the write turn is interrupted before any file → «остановлена», not «не записан»', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `/handoff:handoff auto ${PATH}`, turnId: 'w1' })
  await $.turn.complete(turnDone('w1', undefined, true))
  await w.clock.settle()
  expect(w.toasts).toEqual(['Передача остановлена — ничего не закрыто'])
})

test('F-17/MED-2: an interrupted turn that is not the write turn changes nothing (the handoff goes on)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `/handoff:handoff auto ${PATH}`, turnId: 'w1' })
  await $.turn.complete(turnDone('other', undefined, true))
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.keys()).toContain(`p:${SID}`)
  w.files.set(PATH, T0 + 5000)
  w.texts.set(PATH, NOTE)
  await $.turn.complete(turnDone('w1'))
  await w.clock.settle()
  expect(w.effects).toContain('cmd:exit')
})

test('F-17: a turn whose text does not name the path is not the write turn (its end does not cancel)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: 'привет', turnId: 'chat' })
  await $.turn.complete(turnDone('chat'))
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.keys()).toContain(`p:${SID}`)
})

// ---------- 5-6. терминал Mac (F-18, F-22) ----------

test('F-18/F-22 case 5: Mac terminal happy path: .command file, chmod, open, and only then exit', async ($, on) => {
  const w = world(on, { env: { TMPDIR: '/var/tmp/x/' } })
  await begin($, w)
  await writeTurn($, w)
  const file = `/var/tmp/x/claude-kit-handoff-2026-10-08-090507.command`
  expect(w.writes).toEqual([{ path: file, text: L.macCommandScript('/r', 'claude', L.pastePrompt(PATH, CHAIN)) }])
  expect(w.procs.slice(1).map(p => p.argv)).toEqual([['chmod', '+x', file], ['open', file]])
  // порядок всех действий целиком: exit последний, после open
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'write', 'proc:chmod', 'proc:open', 'cmd:exit'])
  expect(w.effects.indexOf('proc:open')).toBeLessThan(w.effects.indexOf('cmd:exit'))
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-22: the launch and the exit are not run inside the turn.complete hook: they wait for a timer (probe S-0)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `auto ${PATH}`, turnId: 'w1' })
  w.files.set(PATH, T0 + 5000)
  w.texts.set(PATH, NOTE)
  await $.turn.complete(turnDone('w1'))
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff']) // хук вернулся, а окно ещё не открыто и exit не вызван
  await w.clock.settle()
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'write', 'proc:chmod', 'proc:open', 'cmd:exit'])
})

test('F-18: an empty or blank CLAUDE_CODE_EXECPATH falls back to plain claude', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_EXECPATH: '  ' } })
  await begin($, w)
  await writeTurn($, w)
  expect(w.writes[0]!.text).toBe(L.macCommandScript('/r', 'claude', PROMPT))
})

test('F-23: the handoff mark is removed before the window is opened (a crash in the middle cannot open it twice)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(w.procs[0]!.keys).toEqual([]) // git: метки передачи ещё нет
  await writeTurn($, w)
  const open = w.procs.find(p => p.argv[0] === 'open')!
  expect(open.keys).toEqual([`t:${SID}`]) // к моменту open метки p:<id> уже нет
})

test('F-18: without TMPDIR the file goes to /tmp; CLAUDE_CODE_EXECPATH is the claude to run', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_EXECPATH: '/opt/my claude/bin/claude' } })
  await begin($, w)
  await writeTurn($, w)
  expect(w.writes).toEqual([
    { path: '/tmp/claude-kit-handoff-2026-10-08-090507.command', text: L.macCommandScript('/r', '/opt/my claude/bin/claude', PROMPT) },
  ])
})

test('F-18: a handoff with no Chain line still launches (the phrase has no seq)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `auto ${PATH}`, turnId: 'w1' })
  w.files.set(PATH, T0 + 1)
  w.texts.set(PATH, 'без шапки цепочки')
  await $.turn.complete(turnDone('w1'))
  await w.clock.settle()
  expect(w.writes[0]!.text).toBe(L.macCommandScript('/r', 'claude', L.pastePrompt(PATH, null)))
  expect(w.effects).toContain('cmd:exit')
})

test('F-21 case 6: Mac terminal, open exits 1 → phrase on the clipboard, toast says to open a new terminal window, the old session is never closed', async ($, on) => {
  const w = world(on, { proc: argv => (argv[0] === 'open' ? { exitCode: 1 } : undefined) })
  await begin($, w)
  await writeTurn($, w)
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('окно терминала не открылось')])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'write', 'proc:chmod', 'proc:open', 'copy', 'toast'])
})

test('F-21: Mac, chmod fails → no open, fallback, nothing closed', async ($, on) => {
  const w = world(on, { proc: argv => (argv[0] === 'chmod' ? { exitCode: 1 } : undefined) })
  await begin($, w)
  await writeTurn($, w)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'write', 'proc:chmod', 'copy', 'toast'])
  expect(w.toasts).toEqual([FALLBACK('не удалось сделать файл запуска исполняемым')])
})

test('F-21: terminal, the clipboard is unavailable → the whole phrase is in the toast and in the session log', async ($, on) => {
  const w = world(on, { proc: argv => (argv[0] === 'open' ? { exitCode: 1 } : undefined) })
  w.copyOk = false
  await begin($, w)
  await writeTurn($, w)
  const text = `Новая сессия не открылась сама (окно терминала не открылось). Открой новое окно терминала, запусти claude в папке проекта и вставь: ${PROMPT}`
  expect(w.toasts).toEqual([text])
  expect(w.logs).toEqual([text])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
})

test('F-21: the clipboard call itself fails (rejects) → same as no clipboard: the whole phrase in the toast and the log', async ($, on) => {
  const w = world(on, { proc: argv => (argv[0] === 'open' ? { exitCode: 1 } : undefined) })
  w.copyRejects = true
  await begin($, w)
  await writeTurn($, w)
  const text = `Новая сессия не открылась сама (окно терминала не открылось). Открой новое окно терминала, запусти claude в папке проекта и вставь: ${PROMPT}`
  expect(w.toasts).toEqual([text])
  expect(w.logs).toEqual([text])
})

test('F-22: exit is refused → the new window stays open, the failure is shown, no fallback phrase', async ($, on) => {
  const w = world(on, { exit: 'rejects' })
  await begin($, w)
  await writeTurn($, w)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'write', 'proc:chmod', 'proc:open', 'toast'])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]!.startsWith('Новая сессия открыта, но закрыть эту не вышло (')).toBe(true)
  expect(w.copies).toEqual([])
})

// ---------- 7. терминал Windows (F-19) ----------

test('F-19 case 7: Windows terminal without wt: cmd /c start …, then exit', async ($, on) => {
  const w = world(on, { env: { OS: 'Windows_NT' }, git: 'C:\\proj', wt: false })
  await begin($, w)
  await writeTurn($, w, { path: 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md' })
  const path = 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  expect(w.commands[0]).toEqual({ command: 'handoff:handoff', args: `auto ${path}` })
  expect(w.procs.map(p => p.argv).slice(1)).toEqual([
    ['where', 'wt'],
    L.windowsArgv(false, 'C:/proj', 'claude', L.windowsPrompt(L.pastePrompt(path, CHAIN))),
  ])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:where', 'proc:cmd', 'cmd:exit'])
})

test('F-19: Windows terminal with wt: wt -d <root> claude <phrase>, then exit', async ($, on) => {
  const w = world(on, { env: { OS: 'Windows_NT' }, git: 'C:/proj', wt: true })
  const path = 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  await begin($, w)
  await writeTurn($, w, { path })
  expect(w.procs[w.procs.length - 1]!.argv).toEqual(L.windowsArgv(true, 'C:/proj', 'claude', L.windowsPrompt(L.pastePrompt(path, CHAIN))))
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:where', 'proc:wt', 'cmd:exit'])
  expect(w.writes).toEqual([]) // файла .command на Windows нет
})

test('F-19: Windows terminal, the launch exits non-zero → fallback says to open a new terminal window (no Ctrl+N), nothing closed', async ($, on) => {
  const w = world(on, { env: { OS: 'Windows_NT' }, git: 'C:/proj', wt: true, proc: argv => (argv[0] === 'wt' ? { exitCode: 1 } : undefined) })
  const path = 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  await begin($, w)
  await writeTurn($, w, { path })
  expect(w.toasts).toEqual([FALLBACK('окно терминала не открылось')])
  expect(w.copies).toEqual([L.pastePrompt(path, CHAIN)])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
})

for (const root of ['C:/R&D/сайт', 'C:/a;b', 'C:/50%', 'C:/a^b']) {
  test(`F-19: Windows, root ${root} has a character cmd/wt would distort → straight to fallback A with the exact phrase`, async ($, on) => {
    const w = world(on, { env: { OS: 'Windows_NT' }, git: root, wt: true })
    const path = `${root}/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md`
    await begin($, w)
    await writeTurn($, w, { path })
    expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'copy', 'toast'])
    expect(w.copies).toEqual([L.pastePrompt(path, CHAIN)]) // не искажённая windowsPrompt
    expect(w.toasts).toEqual([FALLBACK('путь содержит символы, которые искажает консоль Windows')])
  })
}

test('F-19: the same unsafe path on a Mac is fine (the .command file takes any path)', async ($, on) => {
  const w = world(on, { git: '/R&D/сайт' })
  const path = '/R&D/сайт/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  await begin($, w)
  await writeTurn($, w, { path })
  expect(w.effects).toContain('cmd:exit')
  expect(w.toasts).toEqual([])
})

// ---------- 8, 12. приложение (F-20) ----------

const seedArgs = (w: World) => w.procs.find(p => p.argv.includes('--session-id'))!

test('F-20 case 8: desktop: background seed in default permission mode, then claude://resume with the same id; the record shows up → no fallback, no exit', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME } })
  w.appRecordAfterMs = 2000
  await begin($, w)
  await writeTurn($, w)
  const seed = seedArgs(w)
  const id = seed.argv[3]!
  expect(seed.argv.slice(0, 3)).toEqual(['claude', '-p', '--session-id'])
  expect(UUID.test(id)).toBe(true)
  expect(seed.argv.slice(4)).toEqual(['--permission-mode', 'default', '--output-format', 'json'])
  expect(seed.init!.stdin).toBe(PROMPT)
  expect(seed.init!.cwd).toBe('/r')
  expect(seed.init!.timeoutMs).toBe(180_000) // значение из кода брифа: фоновый запуск может идти до трёх минут
  expect(w.procs[w.procs.length - 1]!.argv).toEqual(['open', `claude://resume?session=${id}`])
  await w.clock.advance(60_000)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:claude', 'proc:open'])
  expect(w.toasts).toEqual([])
  expect(w.copies).toEqual([])
})

test('F-20: the chat record shows up exactly at 60 s → still success; at 60.001 s → fallback', async ($, on) => {
  const late = world(on, { surfaces: ['desktop'], env: { HOME } })
  late.appRecordAfterMs = 60_001
  await begin($, late)
  await writeTurn($, late)
  await late.clock.advance(60_000)
  expect(late.toasts).toEqual([FALLBACK('чат не появился за 60 с', ENDING.appMac)])
})
test('F-20: the chat record shows up exactly at 60 s → success', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME } })
  w.appRecordAfterMs = 60_000
  await begin($, w)
  await writeTurn($, w)
  await w.clock.advance(60_000)
  expect(w.toasts).toEqual([])
  expect(w.copies).toEqual([])
})

test('F-20 case 8: the chat never appears → after 60 s: phrase on the clipboard, toast, old session not closed', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME } })
  await begin($, w)
  await writeTurn($, w)
  await w.clock.advance(59_999)
  expect(w.toasts).toEqual([]) // ещё ждём
  await w.clock.advance(1)
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('чат не появился за 60 с', ENDING.appMac)])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:claude', 'proc:open', 'copy', 'toast'])
})

// Вывод `claude -p --output-format json` при ошибке: JSON с session_id и is_error: true (код выхода 1 или 0).
const seedError = (id: string) => `{"type":"result","subtype":"success","is_error":true,"session_id":"${id}","result":"Not logged in"}`
for (const [name, run, reason] of [
  ['exit 1 and is_error:true with the session id in stdout', (id: string) => ({ exitCode: 1, stdout: seedError(id) }), 'Not logged in'],
  ['exit 0 but is_error:true with the session id in stdout', (id: string) => ({ exitCode: 0, stdout: seedError(id) }), 'Not logged in'],
  ['exit 127, empty stdout, the reason only in stderr', () => ({ exitCode: 127, stdout: '', stderr: 'claude: command not found' }), 'claude: command not found'],
  ['exit 1 with a normal-looking JSON and nothing in stderr', (id: string) => ({ exitCode: 1, stdout: `{"is_error":false,"session_id":"${id}"}` }), 'код 1'],
  ['exit 0 but stdout is not JSON', () => ({ exitCode: 0, stdout: 'Welcome to claude\n' }), 'непонятный ответ (Welcome to claude)'],
] as const) {
  test(`F-20/MED-1: the background run fails (${name}) → the reason in the toast, fallback A, no claude:// link, nothing closed`, async ($, on) => {
    const w = world(on, { surfaces: ['desktop'], env: { HOME }, proc: argv => (argv.includes('-p') ? run(argv[3]!) : undefined) })
    w.appRecordAfterMs = 0 // чат появился бы сразу: ссылка не должна даже открываться
    await begin($, w)
    await writeTurn($, w)
    await w.clock.advance(1000)
    expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:claude', 'copy', 'toast'])
    expect(w.copies).toEqual([PROMPT])
    expect(w.toasts).toEqual([FALLBACK(`фоновый запуск: ${reason}`, ENDING.appMac)])
    expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
  })
}

test('F-20: opening the claude:// link fails (exit 1) → fallback at once, without the 60 s wait', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME }, proc: argv => (argv[0] === 'open' ? { exitCode: 1 } : undefined) })
  await begin($, w)
  await writeTurn($, w)
  expect(w.listed).toBe(0)
  expect(w.toasts).toEqual([FALLBACK('не удалось открыть ссылку на чат', ENDING.appMac)])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
})

test('F-20 case 12: desktop on Windows: rundll32 opens the link, then fallback A with Ctrl+N (the chat cannot be checked), no exit', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { OS: 'Windows_NT' }, git: 'C:/proj' })
  const path = 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  await begin($, w)
  await writeTurn($, w, { path })
  const id = seedArgs(w).argv[3]!
  expect(UUID.test(id)).toBe(true)
  expect(w.procs[w.procs.length - 1]!.argv).toEqual(['rundll32', 'url.dll,FileProtocolHandler', `claude://resume?session=${id}`])
  expect(w.listed).toBe(0)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:claude', 'proc:rundll32', 'copy', 'toast'])
  expect(w.copies).toEqual([L.pastePrompt(path, CHAIN)])
  expect(w.toasts).toEqual([FALLBACK('Windows: проверить появление чата нельзя', ENDING.appWin)])
})

test('F-20: a session drawn on terminal and desktop at once is treated as the app: no exit', async ($, on) => {
  const w = world(on, { surfaces: ['terminal', 'desktop'], env: { HOME } })
  w.appRecordAfterMs = 0
  await begin($, w)
  await writeTurn($, w)
  await w.clock.advance(1000)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:claude', 'proc:open'])
})

test('F-21: terminal and desktop together are the app for the hint as well: «нажми ⌘N», not the terminal hint', async ($, on) => {
  const w = world(on, { surfaces: ['terminal', 'desktop'], env: { HOME }, proc: argv => (argv[0] === 'open' ? { exitCode: 1 } : undefined) })
  await begin($, w)
  await writeTurn($, w)
  expect(w.toasts).toEqual([FALLBACK('не удалось открыть ссылку на чат', ENDING.appMac)])
  expect(w.copies).toEqual([PROMPT])
})

const OPEN_ONLY = (list: string) => `открыть окно можно только из терминала или приложения (поверхности: ${list})`
for (const surfaces of [['vscode'], ['terminal', 'mobile'], ['mobile', 'vscode']] as const) {
  test(`F-18/MED-4: surfaces [${surfaces.join(', ')}] are not all terminal and have no desktop → fallback A, no window, no exit`, async ($, on) => {
    const w = world(on, { surfaces: [...surfaces] })
    await begin($, w)
    await writeTurn($, w)
    expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'copy', 'toast'])
    expect(w.copies).toEqual([PROMPT])
    expect(w.toasts).toEqual([FALLBACK(OPEN_ONLY(surfaces.join(', ')), ENDING.other)])
    expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
  })
}

test('F-18/MED-4: the session has no surface any more at launch time → fallback A («поверхности: нет»), no exit', async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.surfaces = []
  await writeTurn($, w)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'copy', 'toast'])
  expect(w.toasts).toEqual([FALLBACK(OPEN_ONLY('нет'), ENDING.other)])
})

test('F-18/MED-4: a Windows session on [vscode] is not launched through wt/cmd either, and the hint has no Ctrl+N', async ($, on) => {
  const w = world(on, { surfaces: ['vscode'], env: { OS: 'Windows_NT' }, git: 'C:/proj', wt: true })
  const path = 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  await begin($, w)
  await writeTurn($, w, { path })
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'copy', 'toast'])
  expect(w.toasts).toEqual([FALLBACK(OPEN_ONLY('vscode'), ENDING.other)])
})

// Без буфера обмена подсказка тоже зависит от места сессии: приложение — клавиши по ОС, остальное — как с буфером.
const openFails = (argv: readonly string[]) => (argv[0] === 'open' ? { exitCode: 1 } : undefined)
const noClipCases: [string, WorldOpts, string, string][] = [
  ['the app on a Mac', { surfaces: ['desktop'], env: { HOME }, proc: openFails }, 'не удалось открыть ссылку на чат', NOCLIP.appMac],
  ['terminal and desktop together are the app', { surfaces: ['terminal', 'desktop'], env: { HOME }, proc: openFails }, 'не удалось открыть ссылку на чат', NOCLIP.appMac],
  ['VS Code', { surfaces: ['vscode'] }, OPEN_ONLY('vscode'), NOCLIP.other],
]
for (const [name, opts, why, lead] of noClipCases) {
  test(`F-21: the clipboard is unavailable (${name}) → the whole phrase in the toast and the log, with the matching hint`, async ($, on) => {
    const w = world(on, opts)
    w.copyOk = false
    await begin($, w)
    await writeTurn($, w)
    expect(w.toasts).toEqual([NOCLIP_TEXT(why, lead)])
    expect(w.logs).toEqual([NOCLIP_TEXT(why, lead)])
    expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
  })
}

test('F-21: the clipboard is unavailable in the app on Windows → «Нажми Ctrl+N и вставь: <phrase>»', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { OS: 'Windows_NT' }, git: 'C:/proj' })
  w.copyOk = false
  const path = 'C:/proj/docs/handoffs/HANDOFF_auto_2026-10-08-090507.md'
  await begin($, w)
  await writeTurn($, w, { path })
  const text = `Новая сессия не открылась сама (Windows: проверить появление чата нельзя). ${NOCLIP.appWin}: ${L.pastePrompt(path, CHAIN)}`
  expect(w.toasts).toEqual([text])
  expect(w.logs).toEqual([text])
})

test('F-15: a fractional percent is shown rounded (50.6 → 51%)', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(50.6))
  await w.clock.settle()
  expect(w.asked.map(a => a.question)).toEqual(['Контекст 51%. Передать работу в новую сессию?'])
})

// ---------- 9. повторный /handoff-now ----------

test('F-16 case 9: /handoff-now while a handoff is pending says «Передача уже идёт: <path>» and starts nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const first = await typed($, 'handoff-now')
  await w.clock.settle()
  expect(first.text).toBe('Пишу хендофф; потом коммит и новая сессия')
  expect(w.skillRuns()).toEqual([{ command: 'handoff:handoff', args: `auto ${PATH}` }])
  const second = await typed($, 'handoff-now')
  await w.clock.settle()
  expect(second.text).toBe(`Передача уже идёт: ${PATH}`)
  expect(w.skillRuns()).toHaveLength(1)
})

test('F-16: /handoff-now twice back-to-back starts one handoff', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const [a, b] = await Promise.all([typed($, 'handoff-now'), typed($, 'handoff-now')])
  await w.clock.settle()
  expect(w.skillRuns()).toHaveLength(1)
  expect([a.text, b.text].sort()).toEqual(['Передача уже запускается', 'Пишу хендофф; потом коммит и новая сессия'].sort())
})

test('F-16: /handoff-now starts the handoff at 5% context, below any threshold', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.measure(measureArg(5))
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect(w.skillRuns()).toHaveLength(1)
})

test('F-16: while the handoff is being launched (waiting for the app chat) /handoff-now still says «уже идёт»', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME } })
  await begin($, w)
  await writeTurn($, w)
  const r = await typed($, 'handoff-now')
  expect(r.text).toBe(`Передача уже идёт: ${PATH}`)
  expect(w.skillRuns()).toHaveLength(1)
  await w.clock.advance(61_000)
})

test('F-15: while a handoff is pending a drop below the threshold does not re-arm the question', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.session.measure(measureArg(40))
  await $.session.measure(measureArg(65))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-15: while the new session is being opened a drop below the threshold does not re-arm the question either', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME } })
  await begin($, w)
  await writeTurn($, w) // идёт ожидание чата приложения
  await $.session.measure(measureArg(40))
  await $.session.measure(measureArg(65))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(61_000)
})

test('F-15: no question while the handoff is being prepared (the path is not known yet)', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await Promise.all([typed($, 'handoff-now'), $.session.measure(measureArg(50))])
  await w.clock.settle()
  expect(w.asked).toEqual([])
  expect(w.skillRuns()).toHaveLength(1)
})

test('F-16: /handoff-now typed while the question is open, then «Передать» → still one handoff', async ($, on) => {
  const w = world(on)
  w.hold()
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.skillRuns()).toHaveLength(1)
  w.answers.push('Передать')
  w.release()
  await w.clock.settle()
  expect(w.skillRuns()).toHaveLength(1)
})

test('F-16: the same while the new session is being opened: «Передать» starts nothing', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME } })
  w.hold()
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  await typed($, 'handoff-now')
  await w.clock.settle()
  await writeTurn($, w) // идёт ожидание чата приложения
  w.answers.push('Передать')
  w.release()
  await w.clock.settle()
  expect(w.skillRuns()).toHaveLength(1)
  await w.clock.advance(61_000)
})

test('F-16: after the new session was opened /handoff-now works again (the launching mark is cleared)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w)
  expect(w.effects).toContain('cmd:exit')
  const again = await typed($, 'handoff-now')
  await w.clock.settle()
  expect(again.text).toBe('Пишу хендофф; потом коммит и новая сессия')
  expect(w.skillRuns()).toHaveLength(2)
})

test('F-16: after a failed launch (fallback A) /handoff-now works again', async ($, on) => {
  const w = world(on, { proc: argv => (argv[0] === 'open' ? { exitCode: 1 } : undefined) })
  await begin($, w)
  await writeTurn($, w)
  expect(w.toasts).toHaveLength(1)
  const again = await typed($, 'handoff-now')
  await w.clock.settle()
  expect(again.text).toBe('Пишу хендофф; потом коммит и новая сессия')
})

test('F-15: no question while a handoff is pending', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.session.measure(measureArg(90))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-16: the command is registered in an interactive session', async ($, on) => {
  const a = world(on)
  await $.session.start(START)
  expect(a.registered).toEqual([{ name: 'handoff-now', description: DESCRIPTION }])
})
test('F-16/app: a non-interactive start (the desktop app through the SDK; claude -p) registers /handoff-now too, once, with the same description', async ($, on) => {
  const a = world(on, { surfaces: [] })
  await $.session.start(APP_START)
  expect(a.registered).toEqual([{ name: 'handoff-now', description: DESCRIPTION }])
})

test('F-16: the skill cannot be started → the toast says so, the mark is removed, a second try is possible', async ($, on) => {
  const w = world(on, { skill: 'rejects' })
  await $.session.start(START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]!.startsWith('Хендофф не запустился (')).toBe(true)
  expect(w.toasts[0]!.endsWith(') — ничего не закрыто')).toBe(true)
  expect(w.keys()).toEqual([`t:${SID}`])
  const again = await typed($, 'handoff-now')
  expect(again.text).toBe('Пишу хендофф; потом коммит и новая сессия')
})

// ---------- 10. перезапуск (F-23) ----------

const pendingAt = (startedAt: number, path = PATH, writeTurnId: string | null = 'w1') => ({ path, startedAt, root: '/r', writeTurnId })

test('F-23 case 10: restart with a pending mark and a fresh file → the launch step runs (same as case 5)', async ($, on) => {
  // передача началась в 09:04:07 (T0 - 60 с), файл записан в 09:04:37
  const path = '/r/docs/handoffs/HANDOFF_auto_2026-10-08-090407.md'
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - 60_000, path), [`t:${SID}`]: { askAt: 50, armed: false, at: T0 - 60_000 } } })
  w.files.set(path, T0 - 30_000)
  w.texts.set(path, NOTE)
  await $.session.start(START)
  await w.clock.advance(2000)
  // имя временного файла несёт время начала передачи из метки
  const file = '/tmp/claude-kit-handoff-2026-10-08-090407.command'
  expect(w.writes).toEqual([{ path: file, text: L.macCommandScript('/r', 'claude', L.pastePrompt(path, CHAIN)) }])
  expect(w.procs.map(p => p.argv)).toEqual([['chmod', '+x', file], ['open', file]])
  expect(w.effects).toEqual(['write', 'proc:chmod', 'proc:open', 'cmd:exit'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-23: restart, no file yet, still inside 15 min → nothing yet; the timeout is still armed and fires at start + 15 min', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - 5 * MIN) } })
  await $.session.start(START)
  await w.clock.advance(2000)
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])
  await w.clock.advance(10 * MIN - 2000) // ровно 15 мин от начала передачи
  expect(w.toasts).toEqual([])
  await w.clock.advance(1000)
  expect(w.toasts).toEqual(['Хендофф не дождались — ничего не закрыто'])
  expect(w.keys()).toEqual([`t:${SID}`]) // метки передачи нет, осталось состояние вопроса
})

test('F-23: the write turn id survives a restart: that turn ending without a file cancels the handoff', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - MIN, PATH, 'w1') } })
  await $.session.start(START)
  await $.turn.complete(turnDone('w1'))
  await w.clock.settle()
  expect(w.toasts).toEqual(['Хендофф не записан — ничего не закрыто'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-23: restart after the 15 min window with no file → cancelled at once', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - 16 * MIN) } })
  await $.session.start(START)
  await w.clock.advance(2000)
  expect(w.toasts).toEqual(['Хендофф не дождались — ничего не закрыто'])
  expect(w.effects).toEqual(['toast'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-23: restart, the file on disk is older than the start → not a handoff, it waits like a missing file', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - 5 * MIN) } })
  w.files.set(PATH, T0 - 20 * MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(2000)
  expect(w.effects).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])
})

test('F-23: the stored question state is restored: threshold 70 from the store → silent at 65, asks at 70', async ($, on) => {
  const w = world(on, { store: { [`t:${SID}`]: { askAt: 70, armed: true, at: T0 } } })
  await $.session.start(START)
  await $.session.measure(measureArg(65))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(70))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-23/MED-3: restored two days later with a fresh file → fallback A with the phrase; no window, no exit', async ($, on) => {
  const started = T0 - 2 * DAY
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(60_000)
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('передача прервалась')])
  expect(w.effects).toEqual(['copy', 'toast'])
  expect(w.keys()).toEqual([]) // метка снята
})

test('F-23/F-21: restored late in a session that is neither the app nor all-terminal ([vscode]) → fallback A with the generic hint', async ($, on) => {
  const started = T0 - 2 * DAY
  const w = world(on, { surfaces: ['vscode'], store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(60_000)
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('передача прервалась', ENDING.other)])
  expect(w.keys()).toEqual([])
})

test('F-23/F-21: restored late and the list of surfaces cannot be read → the restore still ends in fallback A, with the generic hint', async ($, on) => {
  const started = T0 - 2 * DAY
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(started) } })
  w.surfacesFail = true
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(60_000)
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('передача прервалась', ENDING.other)])
  expect(w.keys()).toEqual([]) // метка снята
})

test('F-23/MED-3: restored two days later with no file → cancelled with the timeout toast, nothing opened', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - 2 * DAY) } })
  await $.session.start(START)
  await w.clock.advance(60_000)
  expect(w.toasts).toEqual(['Хендофф не дождались — ничего не закрыто'])
  expect(w.effects).toEqual(['toast'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-23/MED-3: a mark exactly 15 min old with a fresh file still goes the normal way (the window is not over), 1 ms older it does not', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - WAIT) } })
  w.files.set(PATH, T0 - WAIT + 1000)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(2000)
  expect(w.effects).toEqual(['write', 'proc:chmod', 'proc:open', 'cmd:exit'])
})
test('F-23/MED-3 boundary: a mark 15 min and 1 ms old with a fresh file → fallback A, no window', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(T0 - WAIT - 1) } })
  w.files.set(PATH, T0 - WAIT + 1000)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(2000)
  expect(w.effects).toEqual(['copy', 'toast'])
  expect(w.toasts).toEqual([FALLBACK('передача прервалась')])
})

test('F-23/MED-3: a mark 31 days old is purged BEFORE it is read: nothing is opened, nothing shown, the key is gone', async ($, on) => {
  const started = T0 - 31 * DAY
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN) // файл свежий по отношению к началу передачи
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([])
})

test('F-23/MED-3: a mark of exactly 30 days is not purged, it is restored and (being stale) goes to fallback A', async ($, on) => {
  const started = T0 - 30 * DAY
  const w = world(on, { store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(START)
  await w.clock.advance(2000)
  expect(w.effects).toEqual(['copy', 'toast'])
})

test('F-23/MED-3: a question state 31 days old is purged before it is read: the default threshold applies', async ($, on) => {
  const w = world(on, { store: { [`t:${SID}`]: { askAt: 95, armed: true, at: T0 - 31 * DAY } } })
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

// ---------- перезапуск в приложении: доводка на первом session.attach (F-23) ----------
// Сессия приложения стартует с isInteractive: false и без поверхностей; клиент подключается позже. Метка не снимается
// и ничего не запускается на старте; на первом session.attach идёт та же доводка, что в терминале на старте.

test('F-23/app: a non-interactive start leaves a fresh mark alone and runs nothing; the first session.attach runs the app launch, the second attach does not', async ($, on) => {
  const path = '/r/docs/handoffs/HANDOFF_auto_2026-10-08-090407.md'
  const w = world(on, { surfaces: [], env: { HOME }, store: { [`p:${SID}`]: pendingAt(T0 - 60_000, path) } })
  w.files.set(path, T0 - 30_000) // файл свежий: в терминале на старте это был бы запуск
  w.texts.set(path, NOTE)
  w.appRecordAfterMs = 0
  await $.session.start(APP_START)
  await w.clock.advance(60_000) // клиента ещё нет
  expect(w.effects).toEqual([])
  expect(w.procs).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])

  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await w.clock.advance(2000)
  const seed = seedArgs(w)
  expect(seed.argv.slice(0, 3)).toEqual(['claude', '-p', '--session-id'])
  expect(seed.init!.stdin).toBe(L.pastePrompt(path, CHAIN))
  expect(seed.init!.cwd).toBe('/r')
  expect(w.effects).toEqual(['proc:claude', 'proc:open']) // окно в приложении; exit нет
  expect(w.keys()).toEqual([]) // метка снята

  w.surfaces = ['desktop', 'mobile']
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  await w.clock.advance(60_000)
  expect(w.procs.filter(p => p.argv.includes('--session-id'))).toHaveLength(1)
  expect(w.effects).toEqual(['proc:claude', 'proc:open'])
  expect(w.toasts).toEqual([])
  expect(w.attached).toEqual(['desktop:default', 'mobile:default']) // мод пропускает подключение дальше (next) оба раза
})

// Клиент мог подключиться раньше, чем мод дочитал старт: мод перезапустили в уже открытом чате (session.attach тогда
// не придёт: он срабатывает, когда клиент ПРИСОЕДИНЯЕТСЯ), или подключение пришло, пока session.start ещё шёл.

test('F-23/app: a non-interactive start in a chat the client is already attached to (the mod was restarted) drives a fresh mark at the end of the start, no attach ever comes, once', async ($, on) => {
  const path = '/r/docs/handoffs/HANDOFF_auto_2026-10-08-090407.md'
  const w = world(on, { surfaces: ['desktop'], env: { HOME }, store: { [`p:${SID}`]: pendingAt(T0 - 60_000, path) } })
  w.files.set(path, T0 - 30_000)
  w.texts.set(path, NOTE)
  w.appRecordAfterMs = 0
  await $.session.start(APP_START)
  await w.clock.advance(2000)
  const seed = seedArgs(w)
  expect(seed.argv.slice(0, 3)).toEqual(['claude', '-p', '--session-id'])
  expect(seed.init!.stdin).toBe(L.pastePrompt(path, CHAIN))
  expect(w.effects).toEqual(['proc:claude', 'proc:open'])
  expect(w.keys()).toEqual([])
  // Другой клиент подключается позже: доводка уже была, второго запуска нет. Свежую метку кладём в хранилище вручную:
  // без неё не видно, читает ли подключение хранилище ещё раз (метку прошлой доводки запуск уже снял).
  w.store.set(`p:${SID}`, pendingAt(T0 + 2000 - 30_000))
  w.files.set(PATH, T0 + 2000 - 10_000)
  w.texts.set(PATH, NOTE)
  w.surfaces = ['desktop', 'mobile']
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  await w.clock.advance(60_000)
  expect(w.procs.filter(p => p.argv.includes('--session-id'))).toHaveLength(1)
  expect(w.effects).toEqual(['proc:claude', 'proc:open'])
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])
})

test('F-23/app: the same with a stale mark and a fresh file → fallback A «передача прервалась» at the end of the start, no window, no exit', async ($, on) => {
  const started = T0 - 20 * MIN
  const w = world(on, { surfaces: ['desktop'], env: { HOME }, store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(APP_START)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual(['copy', 'toast'])
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('передача прервалась', ENDING.appMac)])
  expect(w.keys()).toEqual([])
})

test('F-23/app: session.attach arrives while session.start is still running (the session id is not known yet) → the mark is driven once, after the start', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], env: { HOME }, store: { [`p:${SID}`]: pendingAt(T0 - 60_000) } })
  w.files.set(PATH, T0 - 30_000)
  w.texts.set(PATH, NOTE)
  w.appRecordAfterMs = 0
  w.holdStart()
  const starting = $.session.start(APP_START)
  await w.clock.settle()
  await $.session.attach(ATTACH) // старт ещё стоит на чтении id сессии
  expect(w.effects).toEqual([]) // метка ещё не прочитана
  w.releaseStart()
  await starting
  await w.clock.advance(2000)
  expect(w.procs.filter(p => p.argv.includes('--session-id'))).toHaveLength(1)
  expect(w.effects).toEqual(['proc:claude', 'proc:open'])
  expect(w.keys()).toEqual([])
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  await w.clock.advance(60_000)
  expect(w.effects).toEqual(['proc:claude', 'proc:open'])
})

test('F-23/app: the remembered attach alone is enough: the attach came during the start, the roster read at the end of the start is empty', async ($, on) => {
  const w = world(on, { surfaces: [], env: { HOME }, store: { [`p:${SID}`]: pendingAt(T0 - 60_000) } })
  w.files.set(PATH, T0 - 30_000)
  w.texts.set(PATH, NOTE)
  w.appRecordAfterMs = 0
  w.holdStart()
  const starting = $.session.start(APP_START)
  await w.clock.settle()
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  w.surfaces = [] // клиент успел отсоединиться: список поверхностей в конце старта пуст
  w.releaseStart()
  await starting
  w.surfaces = ['desktop'] // к запуску окна клиент снова в списке: иначе открывать нечем (запасной путь А)
  await w.clock.advance(2000)
  expect(w.effects).toEqual(['proc:claude', 'proc:open'])
  expect(w.keys()).toEqual([])
})

test('F-23/app: the deferred restore runs once: a mark that is put into the store after the first attach is not picked up by the second attach', async ($, on) => {
  const w = world(on, { surfaces: [], env: { HOME } })
  await $.session.start(APP_START)
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await w.clock.advance(2000)
  expect(w.effects).toEqual([]) // метки не было: первое подключение ничего не делает
  expect(w.keys()).toEqual([])
  // Метку кладём в хранилище вручную: только так видно, читает ли второе подключение хранилище снова.
  w.store.set(`p:${SID}`, pendingAt(T0 - 30_000))
  w.files.set(PATH, T0 - 10_000)
  w.texts.set(PATH, NOTE)
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  await w.clock.advance(60_000)
  expect(w.effects).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])
})

test('F-23/app: in an interactive session the restore runs at the start, an attach later restores nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.store.set(`p:${SID}`, pendingAt(T0 - 30_000))
  w.files.set(PATH, T0 - 10_000)
  w.texts.set(PATH, NOTE)
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  await w.clock.advance(60_000)
  expect(w.effects).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])
})

test('F-23/app: a stale mark (older than 15 min) with a fresh file is not touched at the start; the first attach shows fallback A «передача прервалась», no window, no exit', async ($, on) => {
  const started = T0 - 20 * MIN
  const w = world(on, { surfaces: [], env: { HOME }, store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(APP_START)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`])

  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual(['copy', 'toast'])
  expect(w.copies).toEqual([PROMPT])
  expect(w.toasts).toEqual([FALLBACK('передача прервалась', ENDING.appMac)])
  expect(w.keys()).toEqual([])
})

test('F-23/app: a stale mark with no file → the first attach cancels with the timeout toast, nothing is opened', async ($, on) => {
  const w = world(on, { surfaces: [], store: { [`p:${SID}`]: pendingAt(T0 - 20 * MIN) } })
  await $.session.start(APP_START)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual([])
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual(['toast'])
  expect(w.toasts).toEqual(['Хендофф не дождались — ничего не закрыто'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

for (const [name, age] of [['fresh', 60_000], ['stale', 20 * MIN]] as const) {
  test(`F-23/app: a ${name} mark and a session that never attaches (claude -p) → nothing is run, nothing is closed, the mark stays in the store`, async ($, on) => {
    const w = world(on, { surfaces: [], store: { [`p:${SID}`]: pendingAt(T0 - age) } })
    w.files.set(PATH, T0 - age + 5000)
    w.texts.set(PATH, NOTE)
    await $.session.start(APP_START)
    await w.clock.advance(60 * MIN)
    expect(w.effects).toEqual([])
    expect(w.procs).toEqual([])
    expect(w.commands).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.keys()).toEqual([`p:${SID}`])
  })
}

test('F-23/app: marks older than 30 days are purged at a non-interactive start with no attach at all, a mark of exactly 30 days stays', async ($, on) => {
  const old = T0 - 30 * DAY - 1
  const edge = T0 - 30 * DAY
  const w = world(on, {
    surfaces: [],
    store: {
      'p:old': { path: '/x.md', startedAt: old, root: '/x', writeTurnId: null },
      't:old': { askAt: 70, armed: true, at: old },
      'p:edge': { path: '/y.md', startedAt: edge, root: '/y', writeTurnId: null },
    },
  })
  await $.session.start(APP_START)
  expect(w.keys()).toEqual(['p:edge'])
})

test('F-23/app: a mark 31 days old is purged at the start, so the first attach finds nothing (even with a fresh file)', async ($, on) => {
  const started = T0 - 31 * DAY
  const w = world(on, { surfaces: [], store: { [`p:${SID}`]: pendingAt(started) } })
  w.files.set(PATH, started + MIN)
  w.texts.set(PATH, NOTE)
  await $.session.start(APP_START)
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await w.clock.advance(60_000)
  expect(w.effects).toEqual([])
  expect(w.keys()).toEqual([])
})

test('F-23/app: the stored question state is restored for an app session: threshold 70 from the store → silent at 65, asks at 70', async ($, on) => {
  const w = world(on, { surfaces: [], store: { [`t:${SID}`]: { askAt: 70, armed: true, at: T0 } } })
  await $.session.start(APP_START)
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await $.session.measure(measureArg(65))
  await w.clock.settle()
  expect(w.asked).toEqual([])
  await $.session.measure(measureArg(70))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-23/app: /handoff-now typed before the first attach is not replaced by the deferred restore: when the skill then fails, the handoff is cancelled with the toast', async ($, on) => {
  const w = world(on, { surfaces: [] })
  w.holdSkill()
  await $.session.start(APP_START)
  await typed($, 'handoff-now')
  await w.clock.settle() // подготовка прошла, метка в хранилище, запуск скилла ждёт
  expect(w.keys()).toEqual([`p:${SID}`, `t:${SID}`])
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH) // метка в хранилище — живая передача этого процесса, доводка её не подхватывает
  w.releaseSkill(true)
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]!.startsWith('Хендофф не запустился (')).toBe(true)
  expect(w.toasts[0]!.endsWith(') — ничего не закрыто')).toBe(true)
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-23/app: the first attach while this process is handing the handoff over (file written, the launch timer not yet fired) does not start a second launch', async ($, on) => {
  const w = world(on, { surfaces: [], env: { HOME } })
  w.appRecordAfterMs = 0
  await $.session.start(APP_START)
  await typed($, 'handoff-now')
  await w.clock.settle()
  await $.turn.start({ text: `/handoff:handoff auto ${PATH}`, turnId: 'w1' })
  w.files.set(PATH, T0 + 1000)
  w.texts.set(PATH, NOTE)
  await w.clock.advance(5000)
  await $.turn.complete(turnDone('w1')) // передачу взяли, запуск ждёт таймер; метка в хранилище ещё лежит
  expect(w.keys()).toEqual([`p:${SID}`, `t:${SID}`])
  w.surfaces = ['desktop']
  await $.session.attach(ATTACH)
  await w.clock.advance(60_000)
  expect(w.procs.filter(p => p.argv.includes('--session-id'))).toHaveLength(1)
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'proc:claude', 'proc:open'])
  expect(w.keys()).toEqual([`t:${SID}`])
})

test('F-23: garbage in the store under our keys does not break the start (defaults are used)', async ($, on) => {
  const w = world(on, { store: { [`t:${SID}`]: 'мусор', [`p:${SID}`]: { path: 5 } } })
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  expect(w.keys()).toEqual([`t:${SID}`]) // мусор убран, записано только новое состояние вопроса
})

test('F-23: a stored question state of the wrong shape is ignored (defaults), it does not silence the question', async ($, on) => {
  const w = world(on, { store: { [`t:${SID}`]: { askAt: 'x', armed: 'yes', at: T0 } } })
  await $.session.start(START)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

// Поле at (время записи) оставлено, чтобы чистка по сроку не убрала запись раньше проверки формы.
for (const [name, bad] of [
  ['path is not a string', { path: 5, startedAt: T0, root: '/r', writeTurnId: null, at: T0 }],
  ['root is not a string', { path: PATH, startedAt: T0, root: 7, writeTurnId: null, at: T0 }],
  ['startedAt is not a number', { path: PATH, startedAt: 'вчера', root: '/r', writeTurnId: null, at: T0 }],
  ['startedAt is not finite', { path: PATH, startedAt: null, root: '/r', writeTurnId: null, at: T0 }],
] as const) {
  test(`F-23: a stored handoff mark of the wrong shape (${name}) is ignored: /handoff-now starts a new handoff`, async ($, on) => {
    const w = world(on, { store: { [`p:${SID}`]: bad } })
    await $.session.start(START)
    await w.clock.advance(2000)
    const r = await typed($, 'handoff-now')
    await w.clock.settle()
    expect(r.text).toBe('Пишу хендофф; потом коммит и новая сессия')
    expect(w.toasts).toEqual([])
  })
}

test('F-23: a stored handoff mark without writeTurnId is still a mark (the write turn is just not known yet)', async ($, on) => {
  const w = world(on, { store: { [`p:${SID}`]: { path: PATH, startedAt: T0 - 5 * MIN, root: '/r' } } })
  await $.session.start(START)
  const r = await typed($, 'handoff-now')
  expect(r.text).toBe(`Передача уже идёт: ${PATH}`)
})

test('F-23: marks older than 30 days are deleted at session start, a mark of exactly 30 days stays', async ($, on) => {
  const old = T0 - 30 * DAY - 1
  const edge = T0 - 30 * DAY
  const w = world(on, {
    store: {
      't:old': { askAt: 70, armed: true, at: old },
      'p:old': { path: '/x.md', startedAt: old, root: '/x', writeTurnId: null },
      't:edge': { askAt: 70, armed: true, at: edge },
      'p:edge': { path: '/y.md', startedAt: edge, root: '/y', writeTurnId: null },
      't:fresh': { askAt: 70, armed: true, at: T0 - DAY },
      'x:garbage': { foo: 1 },
      'x:text': 'строка',
    },
  })
  await $.session.start(START)
  expect(w.keys()).toEqual(['p:edge', 't:edge', 't:fresh'])
})

// ---------- 11. тайм-аут ----------

test('F-17 case 11: 15 min with no file → toast «не дождались», the mark is removed, nothing closed', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await w.clock.advance(WAIT) // ровно 15 мин: ещё не тайм-аут
  expect(w.toasts).toEqual([])
  expect(w.keys()).toEqual([`p:${SID}`, `t:${SID}`])
  await w.clock.advance(1000)
  expect(w.toasts).toEqual(['Хендофф не дождались — ничего не закрыто'])
  expect(w.keys()).toEqual([`t:${SID}`])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'toast'])
})

test('F-17: at the timeout check a file that exists wins over the timeout (written at minute 14, no turn end seen)', async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.files.set(PATH, T0 + 14 * MIN)
  w.texts.set(PATH, NOTE)
  await w.clock.advance(WAIT + 1000)
  expect(w.toasts).toEqual([])
  expect(w.effects).toEqual(['proc:git', 'cmd:handoff:handoff', 'write', 'proc:chmod', 'proc:open', 'cmd:exit'])
})

test('F-15: after the handoff was launched the question stays silent until the context drops below the threshold', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await writeTurn($, w)
  expect(w.effects).toContain('cmd:exit')
  await $.session.measure(measureArg(75))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  await $.session.measure(measureArg(49))
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
})

test('E: two turn ends while the file is already there start the new session once', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: `auto ${PATH}`, turnId: 'w1' })
  w.files.set(PATH, T0 + 1)
  w.texts.set(PATH, NOTE)
  await Promise.all([$.turn.complete(turnDone('w1')), $.turn.complete(turnDone('w1'))])
  await w.clock.settle()
  expect(w.effects.filter(e => e === 'proc:open')).toHaveLength(1)
  expect(w.effects.filter(e => e === 'cmd:exit')).toHaveLength(1)
})

// ---------- сбои, о которых нельзя молчать ----------

test('F-23: the store refuses to save the start → the skill is not run, the reason is in the toast, nothing closed', async ($, on) => {
  const w = world(on)
  w.storeFails = true
  await begin($, w)
  expect(w.skillRuns()).toEqual([])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]!.startsWith('Хендофф не запустился (')).toBe(true)
  expect(w.toasts[0]!.includes('disk full')).toBe(true)
  expect(w.toasts[0]!.endsWith(') — ничего не закрыто')).toBe(true)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]!.startsWith('handoff: хранилище не обновилось')).toBe(true)
  expect(w.commands).toEqual([])
})

test('safety net: an unexpected failure in work nobody waits for is shown as a toast, not swallowed', async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.storeFails = true
  await $.turn.start({ text: `auto ${PATH}`, turnId: 'w1' })
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]!.startsWith('Передача оборвалась (сохранение хода записи): ')).toBe(true)
  expect(w.toasts[0]!.includes('disk full')).toBe(true)
})

test('F-16: /handoff-now cannot be registered → toast with the reason; the question on the threshold still works', async ($, on) => {
  const w = world(on)
  w.registerFails = true
  await $.session.start(START)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]!.startsWith('Команда /handoff-now не зарегистрирована (')).toBe(true)
  expect(w.toasts[0]!.includes('name taken')).toBe(true)
  await $.session.measure(measureArg(50))
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('F-20: the app on a Mac without HOME → fallback with the reason at once, not a silent 60 s wait', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'] })
  await begin($, w)
  await writeTurn($, w)
  expect(w.listed).toBe(0)
  expect(w.toasts).toEqual([FALLBACK('не найден HOME', ENDING.appMac)])
  expect(w.commands.filter(c => c.command === 'exit')).toEqual([])
})
