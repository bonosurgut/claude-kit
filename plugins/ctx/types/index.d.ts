// Контракт плагина ctx: типы его настроек (userConfig из plugin.json)
// и то, что он хранит в $.state.
export type CtxOptions = {
  redAt: number
  cacheMinutes: number
  showCost: boolean
}

// Последние показания, из которых собирается строка: процент контекста,
// окна лимитов (пусто, если лимитов нет: у API-ключей) и стоимость сессии в долларах.
export type CtxSnapshot = {
  percent: number | null
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    // snapshot: последние показания; lastTurnAt: когда кончился последний ход
    // главной сессии, в миллисекундах по $.clock.now() (0, пока ходов не было);
    // line: последняя собранная строка (null — рисовать нечего), её читает полоса над полем ввода в приложении.
    ctx: { snapshot: CtxSnapshot | null; lastTurnAt: number; line: string | null }
  }
}
