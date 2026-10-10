import { composeLine, type LineInput, type LineOpts } from './format'

// В строке состояния цветов нет, поэтому тревожную шкалу контекста отмечает
// значок в начале строки; «кэш остыл» отличается от живого таймера только словами.
// Значок — красный круг, а не ⚠: Claude Code сам рисует статус плагина как
// `⚠ <имя плагина>: <текст>` (замечено вживую в 2.1.295, терминал), и свой ⚠ на этом
// фоне не отличить.
// JUSTIFIED-BY: Claude Code сам рисует статус плагина как `⚠ <имя плагина>: <текст>` (замечено вживую в 2.1.295, терминал), поэтому свой ⚠ не отличить, а цветов в строке состояния нет | UPGRADE: если движок перестанет добавлять свой ⚠ или строка состояния получит цвета, вернуть цветовую шкалу (или ⚠) вместо 🔴 и проверить вид строки вживую
export const ALERT_MARK = '🔴 '
export const SEPARATOR = '   '

// Строка для $.ui.status или undefined, если рисовать нечего.
// Значок ставится, только когда шкала контекста в тревожной зоне (процент после
// округления >= redAt): лимит на 90% и выше значка не даёт.
export function statusLine(input: LineInput, opts: LineOpts): string | undefined {
  const segs = composeLine(input, opts)
  if (segs.length === 0) return undefined
  // composeLine ставит шкалу контекста первой и только если процент известен.
  const ctx = input.percent !== null && input.percent !== undefined ? segs[0] : undefined
  const text = segs.map(s => s.text).join(SEPARATOR)
  return ctx?.tone === 'alert' ? ALERT_MARK + text : text
}
