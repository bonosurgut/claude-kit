import type { AgentInfo } from 'claude-code'
import type { AgentStates } from '../types'
import { SEPARATOR } from './line'
import type { Words } from './words'

// Строка субагентов в полосе над полем ввода (F-26): `работают N  готово M`, затем `  сбой K` только при K > 0
// (части разделены общим SEPARATOR из line.ts); слова и подпись строки — из словаря выбранного языка (F-27), по-английски
// `running N  ready M  failed K`. Подпись строки агентов и подпись строки ctx выровнены по ширине подписи агентов выбранного
// языка (`агенты` или `subagents`): с общей колонкой полоса читается как таблица. Ширина колонки поэтому зависит от языка.
export const agentsLabel = (w: Words): string => w.agents + SEPARATOR
export const alignedCtxLabel = (w: Words): string => 'ctx'.padEnd(w.agents.length) + SEPARATOR

// Корзины считаются по словам движка (AgentStatus, движок 2.1.304): закончил успешно — `completed`;
// закончил неуспешно — `failed` и `killed` (остановлен); всё остальное (`pending`, `running`, `waiting`, `idle`
// и слово, которого плагин не знает) — ещё работает. «Работают» стоит остатком, поэтому три числа строки в
// сумме всегда дают число записей, поданных в agentsRow, кроме помеченных прежним разговором (PREVIOUS ниже, их не считает никто).
// JUSTIFIED-BY: набор слов AgentStatus движка 2.1.304 (три слова конца: completed, failed, killed; остальные четыре — «не конец») | UPGRADE: если движок добавит слово конца (скажем, `cancelled`), агент с ним будет считаться «работает», пока движок не уберёт его из списка (а убранный из списка «работает» remember запишет как «готово»); тогда внести слово в одну из двух корзин ниже и добавить его в таблицу BUCKETS в tests/agents.test.ts
const DONE: readonly string[] = ['completed']
const FAILED: readonly string[] = ['failed', 'killed']

// Пометка «агент прежнего разговора»: её ставит retire() на `/clear` и `/resume` каждому известному id. Это не слово
// движка (с префиксом, чтобы не совпасть ни с одним словом AgentStatus), и не корзина: помеченный агент не входит
// ни в одно число строки, а remember никогда его не перезаписывает, какое бы слово ни вернул движок для этого id.
// JUSTIFIED-BY: типы движка 2.1.304 для agent.list не говорят, что `/clear` или `/resume` убирают записи прежнего разговора из списка (запись агента живёт, пока движок не снимет его задачу, у субагента — позже конца), поэтому сброс не может опираться на опустевший список | UPGRADE: пометки можно заменить обнулением учёта, только если выполнены ОБА условия: (1) проверка на живом движке покажет, что после `/clear` и `/resume` список всегда пуст; (2) чтение списка не может быть в полёте в момент сброса. Одного первого мало: `session.end` не ждёт чтений (минутный тик и хуки перечитывают список сами), и чтение, начатое до сброса и дописанное после него, вернуло бы старых агентов в счёт, а пометки такое чтение отбрасывают. Пока выполнено не оба, пометки остаются
const PREVIOUS = 'ctx:previous-conversation'

// Единственное место, где слово движка превращается в корзину: строку считает agentsRow, а память учёта (remember)
// по нему же решает, «работает» ли пропавший из списка агент.
type Bucket = 'working' | 'done' | 'failed' | 'previous'
function bucketOf(word: string): Bucket {
  if (word === PREVIOUS) return 'previous'
  if (DONE.includes(word)) return 'done'
  if (FAILED.includes(word)) return 'failed'
  return 'working'
}

// Список агентов движка -> состояния по id. Участников команды (у них есть адрес в команде, teammateId) в учёт не
// берём. Вложенные субагенты (parentId указывает на породившего их агента) остаются: список движка плоский,
// они стоят в нём рядом с остальными.
export function statesOf(list: readonly AgentInfo[]): AgentStates {
  const states: AgentStates = {}
  for (const agent of list) {
    if (!agent.teammateId) states[agent.id] = agent.status
  }
  return states
}

// Память учёта (F-26): последнее известное состояние каждого увиденного агента, слитое с новым чтением списка.
// Агент из списка получает своё текущее состояние от движка (закончивший, которому написали, снова «работает»). Агент,
// которого в списке больше нет, сохраняет последнее известное; если оно было «работает», он считается закончившим
// успешно: записывается слово `completed`, и корзину по-прежнему определяет только bucketOf. Пропавший «готово»
// остаётся «готово», пропавший «сбой» остаётся «сбой». Помеченный прежним разговором агент остаётся помеченным,
// есть ли он в списке и с каким бы словом: так `/clear` не зависит от того, уберёт ли движок старых агентов из списка.
// JUSTIFIED-BY: спека ctx 0.2.0 («движок убирает из списка только закончивших; список перечитывается в конце каждого хода агента, так что пропуск настоящего конца редок»); типы движка 2.1.304 для agent.list говорят, что запись агента живёт, пока движок не снимет его задачу (у субагента это происходит позже конца, у участника команды в момент конца или через секунды) | UPGRADE: если движок начнёт убирать из списка и ещё работающих агентов, пропавший «работает» окажется в «готово» ошибочно; тогда держать его «работает» до явного слова конца или до сброса `/clear`. Принятый риск: редкий упавший агент, пропавший из списка до перечитывания, будет учтён как «готово»
// Чистая функция без побочных эффектов и без чтения state: её зовут внутри update(), который при промахе версии
// вызывает её заново на свежем учёте, так что два одновременных чтения списка не теряют ни одного агента, а чтение,
// начатое до `/clear` и дописанное после него, натыкается на пометки и старый счёт не оживляет.
// `seenLater(id)` отвечает «этого агента уже видело в своём списке чтение, начатое позже этого»: такого агента функция
// не трогает, он остаётся с тем словом, что лежит в учёте (в том числе не «заканчивается», если в списке отставшего
// чтения его нет). Так ответ более раннего чтения, дописанный позже, не возвращает агенту старое слово. Агент, которого
// в учёте ещё нет, добавляется всегда: слово ему дано впервые, понижать нечего. По умолчанию (`seenLater` не дан) каждый
// агент учёта обрабатывается как обычно. Различие «видело» и «вывело» держит вызывающий: `seenLater` должен отвечать
// «да» только про тех, кто был в списке более позднего чтения; тот, кого чтение лишь вывело из пропажи («работал,
// в списке нет, значит закончил»), в `seenLater` не попадает, иначе догадка перекрывала бы наблюдение.
export function remember(
  previous: AgentStates,
  list: readonly AgentInfo[],
  seenLater: (id: string) => boolean = () => false,
): AgentStates {
  const current = statesOf(list)
  const merged: AgentStates = {}
  for (const [id, word] of Object.entries(previous)) {
    const bucket = bucketOf(word)
    if (bucket === 'previous' || seenLater(id)) merged[id] = word
    else if (Object.hasOwn(current, id)) merged[id] = current[id]!
    else merged[id] = bucket === 'working' ? DONE[0]! : word
  }
  for (const [id, word] of Object.entries(current)) {
    if (!Object.hasOwn(previous, id)) merged[id] = word
  }
  return merged
}

// Сброс на `/clear` и `/resume`: каждому известному id ставится пометка PREVIOUS. Ids остаются в учёте, чтобы
// remember их узнавал, но ни в одно число строки они больше не входят.
export function retire(states: AgentStates): AgentStates {
  const retired: AgentStates = {}
  for (const id of Object.keys(states)) retired[id] = PREVIOUS
  return retired
}

// undefined, если считать некого (агентов нет или все помечены прежним разговором): строки агентов тогда нет вовсе.
export function agentsRow(states: AgentStates, w: Words): string | undefined {
  const buckets = Object.values(states).map(bucketOf).filter(bucket => bucket !== 'previous')
  if (buckets.length === 0) return undefined
  const done = buckets.filter(bucket => bucket === 'done').length
  const failed = buckets.filter(bucket => bucket === 'failed').length
  const working = buckets.length - done - failed
  const parts = [`${w.working} ${working}`, `${w.done} ${done}`]
  if (failed > 0) parts.push(`${w.failed} ${failed}`)
  return parts.join(SEPARATOR)
}
