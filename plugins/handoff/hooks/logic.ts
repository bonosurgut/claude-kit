import type { HandoffOptions } from '../types'

// Чистая логика мода handoff: ничего не читает и не запускает, поэтому проверяется
// обычными тестами (tests/logic.test.ts). Диск, процессы и $ — в register.ts.

export type Trigger = { askAt: number; armed: boolean }
export type Chain = { tag: string; seq: number }

// ---------- настройки ----------

const DEFAULT_THRESHOLD = 50
const DEFAULT_STEP = 10

// Значение, не являющееся конечным числом (строка, null, NaN, Infinity и т.п.) → запасное.
const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

// Приводит настройки плагина к рабочим: threshold попадает в 1..100 (дробное значение
// остаётся дробным), step становится целым числом не меньше 1 (snooze с таким шагом даёт
// порог выше текущего процента). Значение, не являющееся конечным числом, заменяется
// запасным: 50 для threshold, 10 для step.
export function clampOptions(raw: Readonly<Record<string, unknown>>): HandoffOptions {
  return {
    threshold: Math.min(100, Math.max(1, finiteOr(raw.threshold, DEFAULT_THRESHOLD))),
    step: Math.max(1, Math.round(finiteOr(raw.step, DEFAULT_STEP))),
  }
}

// ---------- порог вопроса (F-15) ----------

export const initialTrigger = (base: number): Trigger => ({ askAt: base, armed: true })

// Процент сравнивается округлённым до целого (Math.round) — так же, как строка ctx рисует процент
// и значок 🔴 и как вопрос называет число: 49.5 уже «50%» и уже спрашивает при пороге 50. Одно и то же
// округлённое число решает и «спросить», и «взвести заново», поэтому на границе нет мигания.
// Округляется только процент; порог (может быть дробным) и askAt сравниваются как есть.
//
// Контекст ниже базового порога: следующий порог снова равен базе и вопрос взведён
// (F-15: порог возвращается к исходному только после того, как контекст упал ниже него).
// Иначе состояние не меняется, а спросить нужно, если вопрос взведён и контекст дошёл
// до текущего порога.
export function measure(t: Trigger, pct: number, base: number): { next: Trigger; ask: boolean } {
  const shown = Math.round(pct)
  if (shown < base) return { next: { askAt: base, armed: true }, ask: false }
  return { next: t, ask: t.armed && shown >= t.askAt }
}

// «Не сейчас»: следующий порог = текущий процент (округлённый до целого) + шаг.
export const snooze = (pct: number, step: number): Trigger => ({ askAt: Math.round(pct) + step, armed: true })

// Передача началась: вопросов нет, пока контекст не упадёт ниже базы (см. measure).
export const startedTrigger = (t: Trigger): Trigger => ({ ...t, armed: false })

// ---------- папка и имя хендоффа (F-10, F-17) ----------

// Порядок и умолчания — как в skills/handoff/scripts/gather.py::pick_handoff_dir.
const DIRS = ['docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs']

// Папки, существование которых нужно проверить, чтобы вызвать pickHandoffDir: четыре кандидата
// в порядке приоритета и `docs/superpowers` (от него зависит умолчание). Проверяет их register.ts.
export const HANDOFF_PROBES: readonly string[] = [...DIRS, 'docs/superpowers']

export function pickHandoffDir(root: string, exists: (p: string) => boolean, isGit: boolean): string {
  if (!isGit) return `${root}/docs/handoffs`
  for (const d of DIRS) if (exists(`${root}/${d}`)) return `${root}/${d}`
  return exists(`${root}/docs/superpowers`) ? `${root}/docs/superpowers/handoffs` : `${root}/docs/handoffs`
}

const p2 = (n: number) => String(n).padStart(2, '0')

// Местное время: YYYY-MM-DD-HHMMSS.
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

export const autoPath = (dir: string, ms: number) => `${dir}/HANDOFF_auto_${stamp(ms)}.md`

// ---------- цепочка и фраза для новой сессии (F-14) ----------

// Читает строку `**Chain:** `тег` seq `N`` (форма из шаблона SKILL.md); нет такой строки → null.
export function parseChain(text: string): Chain | null {
  const m = /\*\*Chain:\*\*\s*`([^`]+)`\s*seq\s*`?(\d+)/.exec(text)
  return m ? { tag: m[1]!, seq: Number(m[2]) } : null
}

export function pastePrompt(path: string, chain: Chain | null): string {
  const ref = chain ? ` (seq ${chain.seq}, ${chain.tag})` : ''
  return [
    `Прочитай \`${path}\`${ref} и продолжи работу с раздела «Where We're Going».`,
    '',
    'Прежде чем начинать:',
    '1. Перескажи в 5–8 строках: цель, текущее состояние, что пробовали и что не вышло',
    '2. Прочитай ТОЛЬКО файлы из «Must-read» в Quick Start',
    '3. Скажи, что проверишь первым и каким будет первый шаг',
    'Потом жди моего «поехали».',
  ].join('\n')
}

// ---------- запуск новой сессии (F-18…F-21) ----------

// Строка для командной оболочки POSIX в одинарных кавычках: внутри них ничего не
// раскрывается, а сама одинарная кавычка записывается как '\''.
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Текст zsh-скрипта для нового окна Терминала Mac: перейти в корень проекта и запустить claude с фразой.
export const macCommandScript = (root: string, bin: string, prompt: string) =>
  `#!/bin/zsh\ncd ${shq(root)} || exit 1\nexec ${shq(bin)} ${shq(prompt)}\n`

// Фраза в одну строку: убирает символы " & | < > ^ %, которые cmd читает как служебные, и
// заменяет `;` на `,` (Windows Terminal читает `;` как разделитель своих команд и разрезал бы
// фразу); остальные символы не трогает. Искажает так и путь к хендоффу внутри фразы, поэтому
// путь с такими символами в фразу класть нельзя: сначала windowsPathSafe.
export const windowsPrompt = (prompt: string) =>
  prompt.replace(/[\r\n]+/g, ' ').replace(/["&|<>^%]/g, '').replace(/;/g, ',')

// Можно ли положить путь в Windows-фразу как есть: false, если в нём есть " & | < > ^ % ;
// или перевод строки (windowsPrompt искажил бы такой путь). По F-19 такой путь в фразу не
// кладут, а идут запасным путём А; это решает вызывающий код, сама функция только отвечает.
export const windowsPathSafe = (path: string): boolean => !/["&|<>^%;\r\n]/.test(path)

// Команда запуска: Windows Terminal (wt), если он есть, иначе новое окно через `cmd /c start`.
// Корень, путь к claude и фраза идут отдельными элементами массива, кавычек вокруг них здесь
// не добавляется. Вложенного `cmd /k` в ветке без wt нет: по F-19 он срезает кавычки, когда в
// пути к claude есть пробел. На Windows не проверено вживую (F-19).
export const windowsArgv = (hasWt: boolean, root: string, bin: string, prompt: string): string[] =>
  hasWt ? ['wt', '-d', root, bin, prompt] : ['cmd', '/c', 'start', '', '/D', root, bin, prompt]

export const openUrlArgv = (isWindows: boolean, url: string): string[] =>
  isWindows ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['open', url]

// ---------- «хендофф записан?» (F-17) ----------

// Файл считается записанным в этой передаче, если его время изменения не раньше начала
// передачи минус допуск 2 секунды. Нет времени изменения (файла нет) → false.
export const isWrittenSince = (mtimeMs: number | undefined, startedAt: number) =>
  mtimeMs !== undefined && mtimeMs >= startedAt - 2000
