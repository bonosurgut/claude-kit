# AGENTS.md — claude-kit

Плагины `ctx` и `handoff` для Claude Code; публичный репозиторий `bonosurgut/claude-kit`. Язык общения,
документов, спек и тикетов — русский.

## Agent skills

Скилы Мэтта Покока (`/grill-with-docs`, `/to-spec`, `/to-tickets`, `/triage` и др.) читают настройки
отсюда. Настроено `/setup-matt-pocock-skills` 22.10.2026.

### Issue tracker

Трекер (место, где лежат спеки и задачи) — локальные markdown-файлы в `.scratch/<фича>/`, в git ветки
`feat/v1`; при публикации на GitHub папка вырезается. See `docs/agents/issue-tracker.md`.

### Triage labels

Пять стандартных статусов (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) —
строка `Status:` в файле тикета. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (один набор на весь репозиторий): `GLOSSARY.md` (словарь терминов проекта) + `docs/adr/`
(ADR — короткие записи архитектурных решений) в корне. Создаются по ходу грилинга, заранее не заводятся.
See `docs/agents/domain.md`.

### Мост со своим процессом (решение 22.10.2026)

- Скилы Мэтта — передняя половина работы: `/grill-with-docs` (допрос дизайна) → `/to-spec` (спека) →
  `/to-tickets` (нарезка на тикеты). Код по тикетам — нашим процессом: исполнитель и ревьюер, затем живая
  проверка в терминале и в приложении (`docs/live-check.md`).
- Прослеживаемость «фича → код → тест» сохраняется: у каждой пользовательской истории в спеке и у каждого
  тикета — ID `F-xx`, продолжая нумерацию `docs/traceability.md` (F-01…F-24 заняты спекой v1). `/to-spec`
  запрещает пути к файлам в спеке — это не конфликт: пути, тесты и статус попадают в матрицу
  `docs/traceability.md` при реализации тикета; DoD (когда фича считается сделанной) — как в глобальном
  `~/.claude/CLAUDE.md`.
- Спека v1 (`docs/superpowers/specs/2026-10-08-claude-kit-design.md`) — история того, что сделано в v1;
  новые фичи в неё не пишутся.
- Эти скилы помечены «запуск только пользователем»: команду набирает пользователь, ассистент подсказывает,
  какую.

## Пути (сводка)

| Что | Где |
|---|---|
| Спека фичи | `.scratch/<фича>/spec.md` |
| Тикеты фичи | `.scratch/<фича>/issues/<NN>-<slug>.md` |
| Настройка трекера | `docs/agents/issue-tracker.md` |
| Статусы триажа | `docs/agents/triage-labels.md` |
| Правила доменных документов | `docs/agents/domain.md` |
| Глоссарий | `GLOSSARY.md` |
| ADR | `docs/adr/` |
| Матрица прослеживаемости | `docs/traceability.md` |
| Живые проверки | `docs/live-check.md` |
| Спека v1 (история) | `docs/superpowers/specs/2026-10-08-claude-kit-design.md` |
