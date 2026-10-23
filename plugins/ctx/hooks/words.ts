// Словарь строк (F-27): единственное место, где записаны слова, которые рисует плагин, по одному набору на язык.
// Сборка строки ctx (format.ts) и строки субагентов (agents.ts) берёт слова только отсюда. Не переводятся и сюда
// не входят: знак `↻`, шкалы `▪▫`, проценты, значок 🔴, подпись `ctx`, вид стоимости `$75.74`, время `10:00`,
// сообщения отладочного журнала (русские при любом языке).
export type Words = {
  fiveHour: string // подпись 5-часового окна
  sevenDay: string // подпись недельного окна
  hour: string // единица часов в остатке до сброса
  minute: string // единица минут: в остатке до сброса и в таймере кэша
  days: readonly string[] // дни недели, с воскресенья: индекс = Date.getDay()
  cache: string // слово кэша
  cold: string // кэш остыл
  agents: string // подпись строки субагентов
  working: string // субагенты: работают
  done: string // субагенты: готово
  failed: string // субагенты: сбой (рисуется, только когда такие есть)
}

export const RU: Words = {
  fiveHour: '5ч',
  sevenDay: 'нед',
  hour: 'ч',
  minute: 'м',
  days: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  cache: 'кэш',
  cold: 'остыл',
  agents: 'агенты',
  working: 'работают',
  done: 'готово',
  failed: 'сбой',
}

export const EN: Words = {
  fiveHour: '5h',
  sevenDay: 'wk',
  hour: 'h',
  minute: 'm',
  days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  cache: 'cache',
  cold: 'cold',
  agents: 'subagents',
  working: 'running',
  done: 'ready',
  failed: 'failed',
}

// Словарь выбранного языка: ровно `en` даёт английский, всё остальное (`ru`, значение вне списка, пусто) — русский.
// Манифест уже ограничивает `lang` списком `ru`/`en`, и движок значение вне списка считает незаданным; сравнение с `en`
// (а не «не `ru`») остаётся страховкой на случай, если незнакомое значение всё же дойдёт до плагина.
export function wordsOf(lang: unknown): Words {
  return lang === 'en' ? EN : RU
}
