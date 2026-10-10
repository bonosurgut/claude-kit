// Контракт плагина handoff: типы его настроек (userConfig из plugin.json)
// и записи, которые мод кладёт в $.store.
export type HandoffOptions = {
  threshold: number
  step: number
}

// Передача, которая идёт: лежит в $.store под ключом `p:<id сессии>`, чтобы пережить
// перезапуск (F-23). `path` — куда скилл должен записать хендофф, `startedAt` — когда
// передача началась (миллисекунды по $.clock.now()), `root` — корень проекта,
// `writeTurnId` — ход, который пишет хендофф (null, пока мод его не увидел).
export type Pending = {
  path: string
  startedAt: number
  root: string
  writeTurnId: string | null
}

// Состояние вопроса о передаче (порог и «взведён ли вопрос»): лежит в $.store под
// ключом `t:<id сессии>`; `at` — когда записано, по нему удаляются записи старше 30 дней.
export type StoredTrigger = {
  askAt: number
  armed: boolean
  at: number
}
