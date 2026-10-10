import type { EngineInterface, Register } from 'claude-code'
import type { Pending, StoredTrigger } from '../types'
import * as L from './logic'

// Мод-триггер handoff (F-15…F-23): на пороге контекста спрашивает «Передать?», запускает скилл
// handoff:handoff в автоматическом режиме, ждёт файл, открывает новую сессию и, если открыл её
// из терминала, закрывает старую последним шагом. Чистая логика (порог, путь, фраза, команды
// запуска) — в logic.ts.
//
// `$` можно передавать только функциям, объявленным на верхнем уровне файла: иначе движок не
// загружает мод («hooks module did not load: $ is passed to … which is not a function declared at
// the top of this file»). Поэтому все такие функции стоят на верхнем уровне, а состояние лежит в
// объекте State, который создаёт register и передаёт им.

type Eng = EngineInterface

type State = {
  base: number // порог вопроса из настроек
  step: number // на сколько процентов должен вырасти контекст после «Не сейчас», чтобы спросить снова
  sid: string // id сессии, под ним метки лежат в $.store
  trigger: L.Trigger
  isAsking: boolean // вопрос на экране
  starting: boolean // идёт подготовка передачи, путь ещё не известен
  pending: Pending | null // передача ждёт файл хендоффа
  launching: Pending | null // файл есть, новая сессия открывается
  restoreOnAttach: boolean // сессия стартовала неинтерактивной, и доводка метки передачи ещё не сделана
  booting: boolean // session.start ещё идёт: id сессии может быть не известен, метку читать рано
  attachSeen: boolean // клиент подключился, пока шёл session.start неинтерактивной сессии
}

const WAIT_MS = 15 * 60_000 // сколько ждать файл хендоффа (F-17)
const APP_WAIT_SEC = 60 // сколько ждать чат в приложении (F-20)
const MARK_TTL = 30 * 24 * 60 * 60_000 // метки старше 30 суток удаляются при старте сессии (F-23)
const RESTART_CHECK_MS = 2000 // после перезапуска: через сколько проверить файл (F-23)

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 120)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// Из $.store читается неизвестно что (старая версия мода, ручная правка). Запись, в которой нет строк
// path и root или конечного числа startedAt, считается отсутствующей; неизвестный ход записи — null.
function asPending(v: unknown): Pending | null {
  if (!isObj(v)) return null
  const { path, startedAt, root, writeTurnId } = v
  if (typeof path !== 'string' || typeof root !== 'string') return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  return { path, startedAt, root, writeTurnId: typeof writeTurnId === 'string' ? writeTurnId : null }
}

function asTrigger(v: unknown): L.Trigger | null {
  if (!isObj(v)) return null
  const { askAt, armed } = v
  return typeof askAt === 'number' && Number.isFinite(askAt) && typeof armed === 'boolean' ? { askAt, armed } : null
}

// Когда записана метка: `at` у состояния вопроса, `startedAt` у передачи; нет ни того ни другого → 0 (будет удалена).
const markedAt = (v: unknown): number =>
  isObj(v) ? (typeof v.at === 'number' ? v.at : typeof v.startedAt === 'number' ? v.startedAt : 0) : 0

// ---------- хранилище и среда ----------

async function savePending($: Eng, s: State) {
  if (s.pending) await $.store.set(`p:${s.sid}`, s.pending)
  else await $.store.delete(`p:${s.sid}`)
}

async function saveTrigger($: Eng, s: State) {
  const record: StoredTrigger = { ...s.trigger, at: await $.clock.now() }
  await $.store.set(`t:${s.sid}`, record)
}

const isWindows = async ($: Eng) => (await $.env.get('OS')) === 'Windows_NT'
// JUSTIFIED-BY: путь к запущенному claude берётся из переменной окружения CLAUDE_CODE_EXECPATH, а её нет в типах API плагинов (поиск по claude-code.d.ts и reference.md версии 2.1.293 ничего не нашёл), так что она не гарантирована; без неё берётся `claude` из PATH | UPGRADE: если переменную уберут или переименуют, новая сессия и фоновый запуск пойдут через `claude` из PATH (при нестандартной установке его там может не быть): найти документированный способ узнать путь к claude и проверить его на установке через npm командой `!echo $CLAUDE_CODE_EXECPATH`
const claudeBin = async ($: Eng) => (await $.env.get('CLAUDE_CODE_EXECPATH'))?.trim() || 'claude'

// Страховка от непредвиденного сбоя: тост вместо молчания (а в хуке — вместо пропуска всего хука движком).
async function guarded($: Eng, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (err) {
    $.ui.toast(`Передача оборвалась (${what}): ${errText(err)}`)
  }
}

const detach = ($: Eng, what: string, work: () => Promise<unknown>) => void guarded($, what, work)

// Как открыть новую сессию руками, зависит от того, где идёт эта (F-21). Клавиши ⌘N / Ctrl+N названы только для
// приложения: по замечанию финального ревью в Терминале ⌘N по умолчанию открывает новое окно с оболочкой, а в VS Code новый файл.
// Возвращает подсказку с маленькой буквы и без хвоста «и вставь».
async function openHint($: Eng, where: Where): Promise<string> {
  if (where === 'app') return `нажми ${(await isWindows($)) ? 'Ctrl+N' : '⌘N'}`
  if (where === 'terminal') return 'открой новое окно терминала, запусти claude в папке проекта'
  return 'открой новую сессию Claude Code в папке проекта'
}

// Запасной путь А (F-21): фраза в буфер обмена и тост с подсказкой по месту сессии (`where`). Нет буфера —
// фраза целиком в тосте и ещё одной строкой в журнале сессии (`$.ui.log` пишет в историю чата): тост висит
// несколько секунд (по умолчанию 4), а запись в истории остаётся.
async function fallback($: Eng, prompt: string, why: string, where: Where) {
  const copied = await $.ui.copy({ text: prompt }).catch(() => ({ isCopied: false as const }))
  const head = `Новая сессия не открылась сама (${why}).`
  const hint = await openHint($, where)
  if (copied.isCopied) {
    $.ui.toast(`${head} Фраза скопирована: ${hint} и вставь`)
    return
  }
  const text = `${head} ${hint[0]!.toUpperCase()}${hint.slice(1)} и вставь: ${prompt}`
  $.ui.toast(text)
  $.ui.log(text)
}

// ---------- запуск передачи (F-16, F-17) ----------

async function projectRoot($: Eng): Promise<{ root: string; isGit: boolean }> {
  const cwd = await $.session.cwd()
  const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
  const top = r?.exitCode === 0 ? r.stdout.trim() : ''
  // Обратные слэши (Windows) заменяются прямыми: logic.ts склеивает пути через `/`.
  return top ? { root: top.replace(/\\/g, '/'), isGit: true } : { root: cwd.replace(/\\/g, '/'), isGit: false }
}

// Таймер на конец окна ожидания (15 мин + 1 с от начала передачи): он запускает check, и тот отменяет передачу, если файла нет.
async function armTimeout($: Eng, s: State, p: Pending) {
  const left = p.startedAt + WAIT_MS + 1000 - (await $.clock.now())
  $.clock.after(Math.max(0, left), () => detach($, 'ожидание файла', () => check($, s, null)))
}

// Подготовка: путь, метка в хранилище. К её концу `s.pending` уже выставлен.
async function prepare($: Eng, s: State): Promise<Pending> {
  const { root, isGit } = await projectRoot($)
  const dirs = new Set<string>()
  if (isGit) {
    for (const d of L.HANDOFF_PROBES) {
      const st = await $.fs.stat(`${root}/${d}`).catch(() => undefined)
      if (st?.kind === 'dir') dirs.add(`${root}/${d}`)
    }
  }
  const now = await $.clock.now()
  const p: Pending = { path: L.autoPath(L.pickHandoffDir(root, d => dirs.has(d), isGit), now), startedAt: now, root, writeTurnId: null }
  s.pending = p
  s.trigger = L.startedTrigger(s.trigger)
  await savePending($, s)
  await saveTrigger($, s)
  return p
}

async function start($: Eng, s: State) {
  if (s.pending || s.launching || s.starting) return
  s.starting = true
  let p: Pending | null = null
  let failure = ''
  try {
    p = await prepare($, s)
  } catch (err) {
    failure = errText(err)
  } finally {
    s.starting = false
  }
  if (!p) {
    await cancel($, s, `Хендофф не запустился (${failure})`)
    return
  }
  await armTimeout($, s, p)
  try {
    await $.command.run({ command: 'handoff:handoff', args: `auto ${p.path}` })
  } catch (err) {
    if (s.pending === p) await cancel($, s, `Хендофф не запустился (${errText(err)})`)
  }
}

// Отмена передачи: старая сессия работает дальше, вопрос снова взведён.
async function cancel($: Eng, s: State, msg: string) {
  s.pending = null
  s.trigger = { ...s.trigger, armed: true }
  $.ui.toast(`${msg} — ничего не закрыто`)
  try {
    await savePending($, s)
    await saveTrigger($, s)
  } catch (err) {
    $.ui.log(`handoff: хранилище не обновилось: ${errText(err)}`, { to: 'debug' })
  }
}

// Ход главной сессии, который только что закончился: его id и прервал ли его человек.
type EndedTurn = { turnId: string; isAborted: boolean }

// Проверка «хендофф записан?»: в конце хода главной сессии, по таймеру ожидания и после перезапуска (F-17, F-23).
async function check($: Eng, s: State, ended: EndedTurn | null) {
  const p = s.pending
  if (!p) return
  const st = await $.fs.stat(p.path).catch(() => undefined)
  const now = await $.clock.now()
  if (s.pending !== p) return // пока ждали диск, передачу довёл или отменил другой вызов
  const isWriteTurn = ended !== null && p.writeTurnId === ended.turnId
  // Человека прервал ход записи: окно не открываем, даже если файл уже лежит (скилл мог ещё делать коммит).
  if (isWriteTurn && ended.isAborted) return cancel($, s, 'Передача остановлена')
  if (L.isWrittenSince(st?.mtimeMs, p.startedAt)) return claim($, s, p)
  if (isWriteTurn) return cancel($, s, 'Хендофф не записан')
  if (now - p.startedAt > WAIT_MS) return cancel($, s, 'Хендофф не дождались')
}

// Передачу берёт один вызов: `pending` сбрасывается сразу, повторная проверка уже ничего не запустит.
// Запуск идёт из таймера, а не из хука конца хода: ожидание чата и `exit` нельзя держать в хуке
// (пробой S-0: exit — только из таймера; плюс `clock.sleep` тратит бюджет хука).
function claim($: Eng, s: State, p: Pending) {
  s.pending = null
  s.launching = p
  $.clock.after(0, () => detach($, 'открытие новой сессии', () => launch($, s, p)))
}

// ---------- новая сессия и закрытие старой (F-18…F-22) ----------

// Где открывать новую сессию: в приложении, если среди поверхностей есть desktop; в терминале — только когда
// ВСЕ поверхности terminal; иначе (VS Code, телефон рядом с терминалом, нет поверхностей) открывать нечем.
type Where = 'app' | 'terminal' | 'other'
const whereOpens = (surfaces: readonly string[]): Where =>
  surfaces.includes('desktop') ? 'app' : surfaces.length > 0 && surfaces.every(x => x === 'terminal') ? 'terminal' : 'other'

async function launch($: Eng, s: State, p: Pending) {
  try {
    await savePending($, s) // метку убираем до запуска: если мод упадёт посреди запуска, после перезапуска второе окно не откроется
    const prompt = L.pastePrompt(p.path, L.parseChain(await $.fs.read(p.path).catch(() => '')))
    const win = await isWindows($)
    const bin = await claudeBin($)
    const surfaces = await $.session.surfaces()
    const where = whereOpens(surfaces)
    let why: string
    try {
      if (where === 'app') why = await openInApp($, p, bin, prompt, win)
      else if (where === 'terminal') why = win ? await openWindows($, p, bin, prompt) : await openMac($, p, bin, prompt)
      else why = `открыть окно можно только из терминала или приложения (поверхности: ${surfaces.join(', ') || 'нет'})`
    } catch (err) {
      why = errText(err)
    }
    if (why) return await fallback($, prompt, why, where)
    if (where === 'terminal') await closeThisSession($) // в приложении старый чат остаётся как есть (F-22)
  } finally {
    s.launching = null
  }
}

// Три способа открыть новую сессию возвращают '' при успехе или причину, по которой нужен запасной путь А.

async function openMac($: Eng, p: Pending, bin: string, prompt: string): Promise<string> {
  const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
  const file = `${tmp}/claude-kit-handoff-${L.stamp(p.startedAt)}.command`
  await $.fs.write(file, L.macCommandScript(p.root, bin, prompt))
  if ((await $.process.run(['chmod', '+x', file])).exitCode !== 0) return 'не удалось сделать файл запуска исполняемым'
  return (await $.process.run(['open', file])).exitCode === 0 ? '' : 'окно терминала не открылось'
}

async function openWindows($: Eng, p: Pending, bin: string, prompt: string): Promise<string> {
  // Путь с символами, которые искажает windowsPrompt, в фразу не кладём: новая сессия получила бы чужой путь (F-19).
  if (!L.windowsPathSafe(p.path)) return 'путь содержит символы, которые искажает консоль Windows'
  const hasWt = (await $.process.run(['where', 'wt']).catch(() => null))?.exitCode === 0
  const r = await $.process.run(L.windowsArgv(hasWt, p.root, bin, L.windowsPrompt(prompt)))
  return r.exitCode === 0 ? '' : 'окно терминала не открылось'
}

// Итог фонового `claude -p --output-format json`: '' при успехе, иначе причина для тоста. Успех — код 0 и вывод,
// который разбирается как JSON и не содержит is_error: true. По замечанию ревью Task 8 при ошибке (не вошёл в
// аккаунт и т.п.) claude печатает JSON с session_id и is_error: true (вживую не проверено), поэтому по одному
// session_id в выводе успех не узнать.
function seedProblem(seed: { exitCode: number; stdout: string; stderr: string }): string {
  let parsed: unknown
  let isJson = true
  try {
    parsed = JSON.parse(seed.stdout)
  } catch {
    isJson = false
  }
  if (isObj(parsed) && parsed.is_error === true) {
    const said = typeof parsed.result === 'string' ? parsed.result : ''
    return (said || seed.stderr.trim() || 'is_error: true').slice(0, 80)
  }
  if (seed.exitCode !== 0) return (seed.stderr.trim() || (isJson ? '' : seed.stdout.trim())).slice(0, 80) || `код ${seed.exitCode}`
  if (!isJson) return `непонятный ответ (${seed.stdout.trim().slice(0, 60)})`
  return ''
}

async function openInApp($: Eng, p: Pending, bin: string, prompt: string, win: boolean): Promise<string> {
  const id = crypto.randomUUID()
  // JUSTIFIED-BY: в `claude -p` правки некому разрешить, поэтому в режиме default они отклоняются (спека F-20), а режим plan оставлял лишний файл в ~/.claude/plans/ (находка живой проверки 2026-10-10, docs/live-check.md) | UPGRADE: если `claude -p` научится спрашивать разрешения или режим plan перестанет оставлять файл, пересмотреть режим; после смены проверить на приложении, что новый чат пересказывает хендофф и после «поехали» может править файлы
  const seed = await $.process.run([bin, '-p', '--session-id', id, '--permission-mode', 'default', '--output-format', 'json'], {
    stdin: prompt,
    cwd: p.root,
    timeoutMs: 180_000,
  })
  const problem = seedProblem(seed)
  if (problem) return `фоновый запуск: ${problem}`
  const opened = await $.process.run(L.openUrlArgv(win, `claude://resume?session=${id}`))
  if (opened.exitCode !== 0) return 'не удалось открыть ссылку на чат'
  if (win) return 'Windows: проверить появление чата нельзя' // путь записи приложения на Windows неизвестен (F-20)
  return (await waitAppRecord($, id)) ? '' : `чат не появился за ${APP_WAIT_SEC} с`
}

// Запись приложения о чате: <HOME>/Library/Application Support/Claude/claude-code-sessions/<аккаунт>/<организация>/local_<id>.json.
// Проверки в моменты 0, 1, …, 60 с.
// JUSTIFIED-BY: приложение пишет запись чата по этому пути, нигде не документированному; путь найден и проверен на приложении 2026-10-10, и приложение может переложить запись без предупреждения | UPGRADE: если запись перестанет находиться по этому пути, ожидание истечёт через 60 с и включится запасной путь А, даже если чат открылся: найти новый путь (посмотреть, что приложение пишет в свою папку при открытии чата) и поправить baseDir или заменить проверку документированным признаком, если он появится
async function waitAppRecord($: Eng, id: string): Promise<boolean> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('не найден HOME')
  const baseDir = `${home}/Library/Application Support/Claude/claude-code-sessions`
  for (let i = 0; i <= APP_WAIT_SEC; i++) {
    for (const acct of await $.fs.list(baseDir).catch(() => [])) {
      if (acct.kind !== 'dir') continue
      for (const org of await $.fs.list(`${baseDir}/${acct.name}`).catch(() => [])) {
        if (org.kind === 'dir' && (await $.fs.stat(`${baseDir}/${acct.name}/${org.name}/local_${id}.json`).catch(() => undefined))) return true
      }
    }
    if (i < APP_WAIT_SEC) await $.clock.sleep(1000)
  }
  return false
}

// Закрытие старой сессии — последний шаг и только после успеха (F-22). Сбой не отменяет уже открытую новую сессию.
async function closeThisSession($: Eng) {
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    $.ui.toast(`Новая сессия открыта, но закрыть эту не вышло (${errText(err)})`)
  }
}

// ---------- вопрос на пороге (F-15) ----------

async function askAndStart($: Eng, s: State, pct: number) {
  let answer = ''
  try {
    answer = await $.ui.ask(`Контекст ${Math.round(pct)}%. Передать работу в новую сессию?`, {
      header: 'Контекст',
      options: ['Передать', 'Не сейчас'],
    })
  } catch {
    // закрытый вопрос — то же, что «Не сейчас» (F-15)
  } finally {
    s.isAsking = false
  }
  if (answer === 'Передать') return start($, s)
  s.trigger = L.snooze(pct, s.step)
  await saveTrigger($, s)
}

// Передача, оставшаяся с прошлого запуска и уже просроченная (прошло больше окна ожидания): окно и exit не нужны.
// Файла нет — отмена; файл есть — запасной путь А (фраза в буфере), старая сессия остаётся.
async function settleStale($: Eng, s: State, p: Pending) {
  const st = await $.fs.stat(p.path).catch(() => undefined)
  if (!L.isWrittenSince(st?.mtimeMs, p.startedAt)) return cancel($, s, 'Хендофф не дождались')
  await savePending($, s) // s.pending пуст: метка снимается
  const prompt = L.pastePrompt(p.path, L.parseChain(await $.fs.read(p.path).catch(() => '')))
  // Не узнать поверхности — не повод ронять восстановление (на старте интерактивной сессии оно не под guarded):
  // тогда подсказка общая («other»).
  const where = whereOpens(await $.session.surfaces().catch(() => []))
  await fallback($, prompt, 'передача прервалась', where)
}

// Состояние сессии, которое читается на каждом старте (F-23): id, чистка меток старше 30 суток и состояние вопроса.
// Чистка идёт раньше чтения: метка старше 30 суток не восстанавливается.
async function restoreState($: Eng, s: State) {
  s.sid = await $.session.id()
  const now = await $.clock.now()
  for (const k of await $.store.keys()) {
    if (now - markedAt(await $.store.get(k)) > MARK_TTL) await $.store.delete(k)
  }
  s.trigger = asTrigger(await $.store.get(`t:${s.sid}`)) ?? s.trigger
}

// Незавершённая передача, оставшаяся с прошлого запуска этой сессии (F-23): довести или отменить. В интерактивной сессии
// вызывается на session.start; в неинтерактивной (приложение через SDK, `claude -p`) — на первом session.attach, а если
// клиент к концу старта уже подключён (мод перезапустили в открытом чате, session.attach тогда не придёт), то в конце
// старта. Голый `claude -p` не подключается никогда: там не вызывается. Если в этом процессе уже идёт своя передача
// (например, /handoff-now набрали до подключения клиента), метку из хранилища не читаем: восстановление не должно
// подменять живую.
async function restorePending($: Eng, s: State) {
  const now = await $.clock.now()
  const p = asPending(await $.store.get(`p:${s.sid}`))
  if (!p || s.pending || s.launching || s.starting) return
  if (now - p.startedAt > WAIT_MS) return settleStale($, s, p)
  s.pending = p
  // Проверить файл скоро, а если его нет — отменить, когда выйдет срок.
  $.clock.after(RESTART_CHECK_MS, () => detach($, 'проверка после перезапуска', () => check($, s, null)))
  await armTimeout($, s, p)
}

async function registerCommand($: Eng) {
  try {
    await $.command.register({ name: 'handoff-now', description: 'Передать работу в новую сессию сейчас' })
  } catch (err) {
    $.ui.toast(`Команда /handoff-now не зарегистрирована (${errText(err)}); вопрос на пороге работает`)
  }
}

export const register: Register = (on, options) => {
  const { threshold, step } = L.clampOptions(options)
  const s: State = {
    base: threshold,
    step,
    sid: '',
    trigger: L.initialTrigger(threshold),
    isAsking: false,
    starting: false,
    pending: null,
    launching: null,
    restoreOnAttach: false,
    booting: false,
    attachSeen: false,
  }

  on('session.start', async ($, e, next) => {
    // Флаги ставим до первого await: session.attach может прийти, пока старт ещё идёт.
    s.restoreOnAttach = !e.isInteractive
    s.attachSeen = false
    s.booting = true
    try {
      await registerCommand($) // приложение стартует с isInteractive: false, команда нужна и там
      await restoreState($, s)
    } finally {
      s.booting = false
    }
    // Метку передачи доводим сразу только в интерактивной сессии. Неинтерактивная (приложение через SDK, `claude -p`)
    // ждёт клиента: обычно он подключается уже после старта (session.attach), но он мог подключиться во время старта
    // (attachSeen) или сидеть в чате ещё до него (мод перезапустили в открытом чате: session.attach не придёт). Тогда
    // доводим в конце старта. Сессия, к которой так никто и не подключился (голый `claude -p`), метку не трогает:
    // она лежит в хранилище, пока её не уберёт чистка меток старше 30 суток на старте какой-нибудь сессии.
    if (e.isInteractive) await restorePending($, s)
    else {
      await guarded($, 'восстановление передачи', async () => {
        const attached = s.attachSeen || (await $.session.surfaces()).length > 0
        if (attached && s.restoreOnAttach) { // флаг проверяем после await: пока читали поверхности, доводку мог начать attach
          s.restoreOnAttach = false
          await restorePending($, s)
        }
      })
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    if (s.restoreOnAttach) {
      if (s.booting) s.attachSeen = true // старт ещё идёт: id сессии может быть не известен, его конец доведёт сам
      else {
        s.restoreOnAttach = false // доводка один раз: следующие подключения её не повторяют
        await guarded($, 'восстановление передачи', () => restorePending($, s))
      }
    }
    return joined
  })

  on('command.run', { command: 'handoff-now' }, async $ => {
    const current = s.pending ?? s.launching
    if (current) return { text: `Передача уже идёт: ${current.path}` }
    if (s.starting) return { text: 'Передача уже запускается' }
    detach($, 'запуск передачи', () => start($, s))
    return { text: 'Пишу хендофф; потом коммит и новая сессия' }
  })

  on('turn.start', async ($, e, next) => {
    const p = s.pending
    if (p && !p.writeTurnId && e.text.includes(p.path)) {
      p.writeTurnId = e.turnId
      await guarded($, 'сохранение хода записи', () => savePending($, s))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await guarded($, 'проверка файла хендоффа', () => check($, s, { turnId: e.turnId, isAborted: e.isAborted }))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const pct = e.context.percent
    if (pct === undefined || s.pending || s.launching || s.starting || s.isAsking) return next(e)
    const r = L.measure(s.trigger, pct, s.base)
    s.trigger = r.next
    if (!r.ask) return next(e)
    s.isAsking = true // до первого await: второе измерение подряд не задаст второй вопрос
    let hasSurface = false
    try {
      hasSurface = (await $.session.surfaces()).length > 0 // без поверхностей (claude -p) спрашивать некого
    } finally {
      if (!hasSurface) s.isAsking = false
    }
    if (hasSurface) detach($, 'вопрос о передаче', () => askAndStart($, s, pct))
    return next(e)
  })
}
