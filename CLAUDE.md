# claude-kit — правила проекта

Плагины `ctx` (строка контекста, лимитов, кэша и стоимости) и `handoff` (передача работы в новую сессию) для
Claude Code. Клиенты ставят их с GitHub: `claude plugin marketplace add bonosurgut/claude-kit`.

## Ветки и публикация

- Работа идёт в `feat/v1`. Ветка `publish` — сжатая история для GitHub (`main`); публикация только по явному
  «да» пользователя.
- Перед публикацией поднять `version` в `plugins/<плагин>/.claude-plugin/plugin.json` каждого изменённого
  плагина: пока номер прежний, `claude plugin update` у клиентов ничего не подтягивает.
- Порядок публикации (из корня репозитория, рабочее дерево чистое):
  1. `git checkout publish && git read-tree -u --reset feat/v1`
  2. `git rm -r -q .scratch` — спеки и тикеты в публичный репозиторий не уходят (пропустить, если папки нет)
  3. Поиск личного в том, что уходит (`git diff --cached HEAD`): путь `/Users/<имя>`, почта, названия рабочих
     проектов пользователя, номера сессий. Нашлось — убрать в `feat/v1`, коммит, начать заново
  4. `git commit` (заголовок: `<плагин> <версия>: <что нового>`), `git push origin publish:main`
  5. `git checkout feat/v1`
  6. Обновить свою установку из домашней папки: `claude plugin marketplace update claude-kit`, затем
     `claude plugin update <плагин>@claude-kit`

## Проверки

- **Смоук** (при старте фазы и после компакции): `claude plugin test plugins/ctx && claude plugin test plugins/handoff`
- `claude plugin test plugins/ctx`, `claude plugin test plugins/handoff`
- `.venv/bin/python -m pytest plugins/handoff/tests -q`
- `claude plugin validate .`, `claude plugin validate plugins/ctx`, `claude plugin validate plugins/handoff`
- Живая проверка в терминале и в приложении Claude — строкой в `docs/live-check.md`; скриншоты в репозиторий
  не кладутся (на них личные сессии).
- Куда приложение пускает вывод мода (строка состояния, полоса над полем ввода, подписи в нижнем ряду),
  меняется от версии приложения. Прежде чем сказать «так нельзя» — пробный мод на каждое место на текущей
  версии (`docs/live-check.md`, строки 9 и 12).

## Agent skills

@AGENTS.md
