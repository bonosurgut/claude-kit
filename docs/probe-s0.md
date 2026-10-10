# Probe S-0 — results (macOS, Claude Code 2.1.293, 2026-10-08)

Throwaway probe; its code is not part of the repo.

| # | Check | Result |
|---|---|---|
| 1 | `claude -p --session-id <uuid> --permission-mode plan --output-format json`, paste prompt on stdin | ✅ exit 0, 20 s, 3 turns, summary of 5–8 lines + "waiting", cost $0.45 (heavy user CLAUDE.md; clients pay less) |
| 2 | `open "claude://resume?session=<uuid>"` | ✅ chat appeared in the app sidebar; record `~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_<uuid>.json` after **2 s**; record has `permissionMode: "default"`, `cwd` = project root |
| 3 | «поехали, создай файл ok.txt» in that chat | ✅ file created — the chat is NOT stuck in plan mode; seeding with `plan` is safe |
| 4 | `$.command.run({ command: 'exit' })` from a mod (via `$.clock.after`) | ✅ terminal session ended, shell prompt back, `Resume this session with: claude --resume <id>` printed; session listed in `claude --resume` |
| 5 | `AbovePrompt` band | ✅ drawn on `terminal` and on `desktop` |
| 5b | `$.ui.status` | ✅ (observed via another installed plugin) drawn in the footer UNDER the prompt in both terminal and app → used for ctx (ruling in ledger) |
| 6 | `$.ui.copy({ text })` in terminal | ✅ `{"isCopied":true}`, surfaces `["terminal"]` |
| 6b | `$.ui.copy` in the app | not checked live; fallback A already shows the full phrase in a toast when `isCopied` is false |

Decisions: F-20 stays as designed (seed in `plan`, open `claude://resume`, wait for `local_<uuid>.json`, 60 s). F-22 exit uses `$.command.run({ command: 'exit' })`, scheduled from a timer, not inside the hook that awaits it. F-07 → status line (footer), `⚠` marker instead of colors (the marker was changed to 🔴 after the live check on 2026-10-10: the engine draws its own `⚠ <plugin name>:` before a plugin status; see spec F-07).

Side finding: another plugin with the same name `ctx` was installed on the dev machine; it was disabled for the live check, since two plugins cannot share a name. Our `ctx` only reads state while drawing (`state.set` inside `ui.render` is refused by the engine).
