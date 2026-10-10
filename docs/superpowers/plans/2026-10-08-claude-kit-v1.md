# claude-kit v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public Claude Code marketplace `bonosurgut/claude-kit` with two plugins — `ctx` (gauges under the prompt) and `handoff` (skill + trigger mod that moves work into a NEW session without `/clear`).

**Architecture:** One repo = one marketplace. Each plugin is a function-hooks mod (`hooks/register.ts[x]`) whose decisions live in a pure `logic.ts`/`format.ts` (unit-tested), while `register` is thin glue over `$`. The handoff skill does the writing (Python scripts: gather / index / commit); the mod decides WHEN, launches the new session per platform, and closes the old one LAST.

**Tech Stack:** Claude Code ≥ 2.1.293 function-hooks API (`'claude-code'`, tests via `'claude-code/testing'` + `claude plugin test`), TypeScript/TSX, Python 3 stdlib (pytest for tests), git.

**Spec:** `<repo>/docs/superpowers/specs/2026-10-08-claude-kit-design.md`

**API reference for every mod task:** `/private/tmp/claude-501/bundled-skills/2.1.293/c5f0a813facf220afa280149dd852280/plugin-authoring/types/claude-code.d.ts` (≈14k lines — grep the name, read the declaration) and `.../plugin-authoring/reference.md`. If that folder is gone (process restarted), load the `plugin-authoring` skill again — it writes a fresh copy and names its path. **Where the code below and the types disagree, the types win**: fix the code, note the deviation in your report.

Phase 1 features: F-01, F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11, F-12, F-13, F-14, F-15, F-16, F-17, F-18, F-19, F-20, F-21, F-22, F-23, F-24

## Global Constraints

- Claude Code ≥ 2.1.293 (was 2.1.286 in the first draft; 2.1.293 is the oldest version checked live); Python ≥ 3.8 stdlib only; no network calls anywhere (no `$.http`).
- Platforms: macOS + Windows. Linux is out of scope. Windows paths are **"не проверено вживую"** in README and `docs/traceability.md` (status `partial`).
- Client-facing text (toasts, questions, README, paste prompt) — Russian. Skill instructions (`SKILL.md`) — English.
- Defaults: handoff threshold **50**, snooze step **10**; ctx red-from **50** (🔴 mark, no yellow zone), cache TTL **5** min, show cost **true**. (Changed from 60/60 by the user before publishing; the code snippets below are the original drafts and still show 60.)
- Ideas from Nikita Vels's mods are allowed; **no code or text copied** from `~/.claude/nickvels-mods` or `~/Downloads/nickvels-mods`. Implementers must not open those folders.
- Old session closes **last** — only after the new one verifiably started. Fallback A never closes the old one.
- No silent failure: every failure path ends in a toast / printed `*_FAILED:` / `SKIPPED_*:` line.
- Secret patterns never committed: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*credentials*`, `*secret*`, `*.keystore`, `*.env`, `id_ecdsa*`, `id_dsa*`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Repo root: `<repo>` (already `git init`, spec committed). **Never push**; publishing is a separate user command.

## Review Focus

1. **Paths with spaces and Cyrillic** (`/Users/Иван/Мои проекты/сайт`) — every script and every launch argv must survive them. Tests: Task 4 (`test_gather_cyrillic_space`), Task 5 (`test_commit_cyrillic_space`), Task 7 (`macCommandScript` / `windowsArgv` quoting tests).
2. **Handoff dir ignored by `.gitignore`** (`.claude/` ignored in many repos) — commit must skip it loudly, not abort. Test: Task 5 `test_ignored_handoff_reported`.
3. **Context jumps over the threshold in one step** (55 → 83 after a big file read) — ask once, snooze from the *current* value (83 → next 93), never from the threshold. Test: Task 8 `jump over threshold`.
4. **Python missing on Windows** — skill must still produce a handoff by plain git commands; README lists Python as a prerequisite. Covered in Task 6 SKILL.md fallback section + Task 11 README.
5. **A stale handoff file at the target path** (same name existing before the start) — must not count as "written". Tests: Task 7 `isWrittenSince: old file is not a written handoff`, Task 8 case 4.

---

### Task 1: Probe S-0 (orchestrator + user, NOT a subagent)

Runs on the user's Mac, needs the desktop app UI. Output: `docs/probe-s0.md` with one line per item: works / doesn't / numbers. Probe code is throwaway (scratchpad), never committed.

**Files:**
- Create: `docs/probe-s0.md`

- [ ] **Step 1: headless seed.** In a scratch git repo with a dummy handoff file `H.md`, run
  `claude -p --session-id <uuidgen> --permission-mode plan --output-format json` with stdin = the paste prompt (Task 7 `pastePrompt('H.md', null)`). Record: exit code, whether `result` is a 5–8-line summary, seconds taken.
- [ ] **Step 2: import.** `open "claude://resume?session=<uuid>"`. Record: does a new chat appear in the app sidebar; seconds; does `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_<uuid>.json` exist (record exact naming if different).
- [ ] **Step 3: mode after "поехали".** User types «поехали, создай файл ok.txt» in that chat. Record: did it edit, or stay in plan mode. If stuck — try seeding with `--permission-mode default` and repeat Steps 1–3.
- [ ] **Step 4: exit from a mod.** Minimal dev mod in `~/.claude/dev-mods/<session>/probe/` with command `/probe-exit` → `await $.command.run({ command: 'exit' })`. Record: terminal session ended; `claude --resume` lists it.
- [ ] **Step 5: band on desktop.** Same probe mod draws `AbovePrompt` text `probe`. Record: visible in terminal? in the app Code tab?
- [ ] **Step 6: clipboard.** `/probe-copy` → `$.ui.copy({ text: 'probe', surface: e.surface })` from a `command.run`; record `isCopied` in terminal and app.
- [ ] **Step 7: write `docs/probe-s0.md`, decide.** If Steps 1–3 fail with both modes → STOP, ask the user: F-20 collapses to fallback A. If Step 5 fails on desktop → Task 3 adds `$.ui.status` mirror (code already included). Commit:
```bash
git -C "<repo>" add docs/probe-s0.md
git -C "<repo>" commit -m "docs: probe S-0 results"
```

---

### Task 2: Marketplace + plugin skeletons (F-01, F-24)

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/ctx/.claude-plugin/plugin.json`, `plugins/ctx/hooks/hooks.json`, `plugins/handoff/.claude-plugin/plugin.json`, `plugins/handoff/hooks/hooks.json`, `.gitignore`

**Interfaces:**
- Produces: plugin names `ctx`, `handoff`; marketplace name `claude-kit`; options keys `ctx: redAt, cacheMinutes, showCost`, `handoff: threshold, step` (read in Tasks 3 and 9 as `options.<key>`).

- [ ] **Step 1: write `.claude-plugin/marketplace.json`**
```json
{
  "name": "claude-kit",
  "owner": { "name": "bonosurgut" },
  "metadata": { "description": "Бесплатный набор для Claude Code: шкалы контекста и лимитов, передача работы в новую сессию" },
  "plugins": [
    { "name": "ctx", "source": "./plugins/ctx", "description": "Шкалы под полем ввода: контекст, лимиты 5 ч и недели, кэш, стоимость" },
    { "name": "handoff", "source": "./plugins/handoff", "description": "Хендофф сессии: на пороге контекста пишет документ передачи, коммитит и открывает новую сессию" }
  ]
}
```
- [ ] **Step 2: write `plugins/ctx/.claude-plugin/plugin.json`**
```json
{
  "name": "ctx",
  "version": "0.1.0",
  "description": "Шкалы под полем ввода: контекст, лимиты 5 ч и недели, кэш, стоимость",
  "author": { "name": "bonosurgut" },
  "types": "./types/index.d.ts",
  "userConfig": {
    "redAt":        { "type": "number",  "title": "Красная шкала контекста с, %", "description": "С какого процента шкала контекста красная", "default": 60 },
    "cacheMinutes": { "type": "number",  "title": "Срок кэша, мин", "description": "Через сколько минут после ответа кэш считается остывшим", "default": 5 },
    "showCost":     { "type": "boolean", "title": "Показывать стоимость", "description": "Показывать стоимость сессии в $", "default": true }
  }
}
```
- [ ] **Step 3: write `plugins/handoff/.claude-plugin/plugin.json`**
```json
{
  "name": "handoff",
  "version": "0.1.0",
  "description": "Хендофф сессии: на пороге контекста пишет документ передачи, коммитит и открывает новую сессию",
  "author": { "name": "bonosurgut" },
  "types": "./types/index.d.ts",
  "userConfig": {
    "threshold": { "type": "number", "title": "Порог вопроса, %", "description": "На каком проценте контекста спросить о передаче", "default": 60 },
    "step":      { "type": "number", "title": "Повторить через, %", "description": "Насколько вырасти контексту после «Не сейчас», чтобы спросить снова", "default": 10 }
  }
}
```
- [ ] **Step 4: both `hooks/hooks.json`**: ctx → `{ "modules": ["./register.tsx"] }`; handoff → `{ "modules": ["./register.ts"] }`. `.gitignore`: `__pycache__/`, `.pytest_cache/`, `**/.claude-plugin/types/` (the folder sits inside each plugin, so the `**/` is needed), `.DS_Store`, `.venv/`.
- [ ] **Step 5: stub modules so validate can run** — `plugins/ctx/hooks/register.tsx` and `plugins/handoff/hooks/register.ts` each:
```ts
import type { Register } from 'claude-code'
export const register: Register = () => {}
```
and `types/index.d.ts` in each plugin: `export {}`.
- [ ] **Step 6: validate.** Run (from `~`, NOT inside the repo):
  `claude plugin validate <repo>`, then the same for `.../plugins/ctx` and `.../plugins/handoff`. Expected: `✔ Validation passed` ×3. If `userConfig` shape is refused, fix per the types file (`userConfig` doc near line 7591) and record it.
- [ ] **Step 7: commit** `feat: marketplace and plugin skeletons`.

---

### Task 3: ctx — format logic + band (F-03…F-07)

**Files:**
- Create: `plugins/ctx/hooks/format.ts`, `plugins/ctx/tests/format.test.ts`, `plugins/ctx/tests/band.test.ts`
- Modify: `plugins/ctx/hooks/register.tsx` (replace stub), `plugins/ctx/types/index.d.ts`

**Interfaces:**
- Consumes: options `redAt`, `cacheMinutes`, `showCost` (Task 2).
- Produces: `composeLine(input: LineInput, opts: LineOpts): Segment[]` (used only inside ctx).

- [ ] **Step 1: failing tests `plugins/ctx/tests/format.test.ts`**
```ts
import { test, expect } from 'claude-code/testing'
import { bar, contextTone, limitSegment, cacheSegment, costSegment, composeLine } from '../hooks/format'

test('bar: 0/50/62/100 percent', () => {
  expect(bar(0)).toBe('▫▫▫▫▫▫▫▫')
  expect(bar(50)).toBe('▪▪▪▪▫▫▫▫')
  expect(bar(62)).toBe('▪▪▪▪▪▫▫▫')
  expect(bar(100)).toBe('▪▪▪▪▪▪▪▪')
  expect(bar(140)).toBe('▪▪▪▪▪▪▪▪')
  expect(bar(-5)).toBe('▫▫▫▫▫▫▫▫')
})

test('contextTone: boundaries 49/50/59/60 with red=60', () => {
  expect(contextTone(49, 60)).toBe('normal')
  expect(contextTone(50, 60)).toBe('warn')
  expect(contextTone(59, 60)).toBe('warn')
  expect(contextTone(60, 60)).toBe('alert')
})

test('contextTone: red below 50 has no warn band', () => {
  expect(contextTone(39, 40)).toBe('normal')
  expect(contextTone(40, 40)).toBe('alert')
})

test('limitSegment: five_hour, seven_day with reset, unknown kind hidden', () => {
  expect(limitSegment({ kind: 'five_hour', percentUsed: 14 })!.text).toBe('5ч ▪▫▫▫▫▫▫▫ 14%')
  // 2026-10-15 is a Thursday; local time 10:00
  const resetsAt = new Date(2026, 9, 15, 10, 0).toISOString()
  expect(limitSegment({ kind: 'seven_day', percentUsed: 48, resetsAt })!.text).toBe('нед ▪▪▪▪▫▫▫▫ 48% · сброс чт 10:00')
  expect(limitSegment({ kind: 'spend_limit', percentUsed: 5 })).toBe(null)
})

test('cacheSegment: none before first turn, minutes, cold at ttl', () => {
  const min = 60_000
  expect(cacheSegment(10 * min, 0, 5)).toBe(null)
  expect(cacheSegment(10 * min, 10 * min - 3 * min - 1000, 5)!.text).toBe('кэш ◷ 3м')
  expect(cacheSegment(10 * min, 10 * min - 4 * min - 59_000, 5)!.tone).toBe('normal')
  expect(cacheSegment(10 * min, 10 * min - 5 * min, 5)).toEqual({ text: 'кэш остыл', tone: 'dim' })
})

test('costSegment: two decimals, hidden when off or absent', () => {
  expect(costSegment(1.8449, true)!.text).toBe('$1.84')
  expect(costSegment(1.84, false)).toBe(null)
  expect(costSegment(null, true)).toBe(null)
})

test('composeLine: API-key session (no limits, no cost) draws only ctx + cache', () => {
  const segs = composeLine(
    { percent: 62, rateLimits: [], usd: null, now: 600_000, lastTurnAt: 420_000 },
    { redAt: 60, cacheMinutes: 5, showCost: true },
  )
  expect(segs.map(s => s.text)).toEqual(['ctx ▪▪▪▪▪▫▫▫ 62%', 'кэш ◷ 3м'])
  expect(segs[0].tone).toBe('alert')
})

test('composeLine: nothing known draws nothing', () => {
  expect(composeLine({ percent: null, rateLimits: [], usd: null, now: 0, lastTurnAt: 0 },
    { redAt: 60, cacheMinutes: 5, showCost: true })).toEqual([])
})
```
- [ ] **Step 2: run, expect FAIL** — `claude plugin test <repo>/plugins/ctx` → fails: module `../hooks/format` not found.
- [ ] **Step 3: implement `plugins/ctx/hooks/format.ts`**
```ts
export type Tone = 'normal' | 'warn' | 'alert' | 'dim'
export type Segment = { text: string; tone: Tone }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type LineInput = { percent: number | null; rateLimits: readonly Limit[]; usd: number | null; now: number; lastTurnAt: number }
export type LineOpts = { redAt: number; cacheMinutes: number; showCost: boolean }

const CELLS = 8
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const LABELS: Record<string, string> = { five_hour: '5ч', seven_day: 'нед' }

export function bar(percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  const full = Math.round((p / 100) * CELLS)
  return '▪'.repeat(full) + '▫'.repeat(CELLS - full)
}

export function contextTone(percent: number, redAt: number): Tone {
  if (percent >= redAt) return 'alert'
  if (percent >= Math.min(50, redAt)) return 'warn'
  return 'normal'
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function limitSegment(l: Limit): Segment | null {
  const label = LABELS[l.kind]
  if (!label) return null
  const pct = Math.round(l.percentUsed)
  let text = `${label} ${bar(pct)} ${pct}%`
  if (l.kind === 'seven_day' && l.resetsAt) {
    const d = new Date(l.resetsAt)
    if (!Number.isNaN(d.getTime())) text += ` · сброс ${DAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  return { text, tone: pct >= 90 ? 'alert' : pct >= 70 ? 'warn' : 'normal' }
}

export function cacheSegment(now: number, lastTurnAt: number, cacheMinutes: number): Segment | null {
  if (lastTurnAt <= 0) return null
  const elapsed = now - lastTurnAt
  if (elapsed >= cacheMinutes * 60_000) return { text: 'кэш остыл', tone: 'dim' }
  return { text: `кэш ◷ ${Math.floor(elapsed / 60_000)}м`, tone: 'normal' }
}

export function costSegment(usd: number | null, show: boolean): Segment | null {
  if (!show || usd === null || usd === undefined) return null
  return { text: `$${usd.toFixed(2)}`, tone: 'normal' }
}

export function composeLine(i: LineInput, o: LineOpts): Segment[] {
  const out: Segment[] = []
  if (i.percent !== null && i.percent !== undefined) {
    const pct = Math.round(i.percent)
    out.push({ text: `ctx ${bar(pct)} ${pct}%`, tone: contextTone(pct, o.redAt) })
  }
  for (const kind of ['five_hour', 'seven_day']) {
    const l = i.rateLimits.find(r => r.kind === kind)
    const s = l ? limitSegment(l) : null
    if (s) out.push(s)
  }
  const c = cacheSegment(i.now, i.lastTurnAt, o.cacheMinutes)
  if (c) out.push(c)
  const m = costSegment(i.usd, o.showCost)
  if (m) out.push(m)
  return out
}
```
Note: `costSegment(1.8449)` → `toFixed(2)` gives `'1.84'` ✔.
- [ ] **Step 4: run, expect PASS** (8 tests).
- [ ] **Step 5: contract `plugins/ctx/types/index.d.ts`**
```ts
export type CtxSnapshot = {
  percent: number | null
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    ctx: { snapshot: CtxSnapshot | null; lastTurnAt: number; tick: number }
  }
}
```
- [ ] **Step 6: failing band test `plugins/ctx/tests/band.test.ts`.** Look up the testing kit's `mount` in the types (`declare module 'claude-code/testing'`, ~line 14718) and write, looping surfaces `['terminal', 'desktop'] as const`:
  (a) after `$.session.measure({ context: { window: 200000, percent: 62 }, rateLimits: [], changed: ['context'] })` the mounted `AbovePrompt` text contains `ctx ▪▪▪▪▪▫▫▫ 62%` and does NOT contain `5ч`;
  (b) with `rateLimits: [{ kind: 'five_hour', percentUsed: 14 }]` it contains `5ч ▪▫▫▫▫▫▫▫ 14%`;
  (c) with test option `{ options: { showCost: false } }` and `cost: { usd: 2 }` it does NOT contain `$2.00`, and with defaults it does.
  Use `mock.clock(on, { now: 1_000_000 })` so the cache timer is deterministic. Run → FAIL (stub register draws nothing).
- [ ] **Step 7: implement `plugins/ctx/hooks/register.tsx`**
```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { CtxSnapshot } from '../types'
import { composeLine, type Tone } from './format'

const snapshot = atom({ plugin: 'ctx', key: 'snapshot' } as const, null as CtxSnapshot | null)
const lastTurnAt = atom({ plugin: 'ctx', key: 'lastTurnAt' } as const, 0)
const tick = atom({ plugin: 'ctx', key: 'tick' } as const, 0)

const COLOR: Record<Tone, string | undefined> = { normal: undefined, warn: 'warning', alert: 'error', dim: undefined }

export const register: Register = (on, options: any) => {
  const opts = {
    redAt: Number(options?.redAt ?? 60),
    cacheMinutes: Number(options?.cacheMinutes ?? 5),
    showCost: options?.showCost !== false,
  }

  const take = (u: { context: { percent?: number }; rateLimits: readonly any[]; cost?: { usd: number } }): CtxSnapshot => ({
    percent: u.context?.percent ?? null,
    rateLimits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    usd: u.cost?.usd ?? null,
  })

  on('session.start', async ($, e, next) => {
    const u = await $.session.usage()
    await update($, snapshot, () => take(u))
    // Cache timer moves without turns: redraw once a minute
    $.clock.every(60_000, () => void update($, tick, n => (n ?? 0) + 1))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => take(e))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, lastTurnAt, () => now)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    await read($, tick)
    if (!s) return next(e)
    const segs = composeLine(
      { ...s, now: await $.clock.now(), lastTurnAt: await read($, lastTurnAt) },
      opts,
    )
    if (segs.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {segs.map((sg, i) => (
          <Text key={`s${i}`} color={COLOR[sg.tone]} dimColor={sg.tone === 'dim'}>
            {(i > 0 ? '   ' : '') + sg.text}
          </Text>
        ))}
      </Box>
    )
  })
}
```
If probe S-0 Step 5 showed the band is NOT drawn on desktop: in `session.measure` and `turn.complete` also call `$.ui.status(segs.map(s => s.text).join('   '))` and add a test that `status` receives the same string.
- [ ] **Step 8: run all ctx tests → PASS**; `claude plugin validate .../plugins/ctx` → passed; `tsc -p plugins/ctx` per the skill's tsconfig note → no errors.
- [ ] **Step 9: mutation check** — temporarily change `percent >= redAt` to `>` in `contextTone`; the 60/60 test must FAIL; revert. Change `LABELS.five_hour` to `'5h'`; band test (b) must FAIL; revert.
- [ ] **Step 10: commit** `feat(ctx): gauges under the prompt`.

---

### Task 4: handoff skill scripts — gather.py + index.py (F-09, F-10)

**Files:**
- Create: `plugins/handoff/skills/handoff/scripts/gather.py`, `plugins/handoff/skills/handoff/scripts/index.py`, `plugins/handoff/tests/test_gather.py`, `plugins/handoff/tests/test_index.py`, `plugins/handoff/tests/conftest.py`

**Interfaces:**
- Produces: `gather.py [chain_tag]` prints lines `ROOT:`, `NOT_GIT: yes` (only without git), `BRANCH:`, `HANDOFF_DIR: <abs>` (+ ` (does not exist yet — create it)`), `FRESH_STANDALONE_TAG: standalone-<8 hex>`, sections as in the original. Function `pick_handoff_dir(root: Path, is_git: bool) -> Path`. `index.py PATH TAG SEQ DATE STATUS TOPIC NEXT` prints `INDEX:`, `APPENDED (<n> chars):`, `HANDOFF_LINES: <n>`.

- [ ] **Step 1: `conftest.py`** — fixture `repo(tmp_path)` that runs `git init -q`, sets `user.email`/`user.name` locally, commits one file `a.txt`; fixture `run(script, *args, cwd)` that runs `sys.executable -I <script> ...` with `encoding='utf-8'` and returns stdout. Scripts path: `Path(__file__).parents[1] / 'skills/handoff/scripts'`.
- [ ] **Step 2: failing tests `test_gather.py`**
```python
from pathlib import Path
import re

def lines(out):
    return dict(l.split(': ', 1) for l in out.splitlines() if ': ' in l and not l.startswith('---'))

def test_gather_git_defaults_to_claude_handoffs(repo, run):
    d = lines(run('gather.py', cwd=repo))
    assert d['ROOT'] == str(repo)
    assert 'NOT_GIT' not in d
    assert d['HANDOFF_DIR'] == f"{repo / '.claude' / 'handoffs'} (does not exist yet — create it)"
    assert re.fullmatch(r'standalone-[0-9a-f]{8}', d['FRESH_STANDALONE_TAG'])

def test_gather_prefers_existing_dir_order(repo, run):
    (repo / 'plans/handoffs').mkdir(parents=True)
    (repo / '.claude/handoffs').mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'] == str(repo / 'plans' / 'handoffs')

def test_gather_superpowers_default(repo, run):
    (repo / 'docs/superpowers').mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'].startswith(str(repo / 'docs/superpowers/handoffs'))

def test_gather_no_git(tmp_path, run):
    d = lines(run('gather.py', cwd=tmp_path))
    assert d['NOT_GIT'].startswith('yes')
    assert d['HANDOFF_DIR'].startswith(str(tmp_path / '.claude' / 'handoffs'))

def test_gather_cyrillic_space(tmp_path, run, make_repo):
    r = make_repo(tmp_path / 'Мои проекты' / 'сайт')
    assert lines(run('gather.py', cwd=r))['ROOT'] == str(r)

def test_gather_chain_by_seq_not_mtime(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1_b_2026-01-02.md').write_text('**Chain:** `t1` seq `2`\n## Where We\'re Going\n- step two\n', encoding='utf-8')
    (h / 'HANDOFF_t1_a_2026-01-01.md').write_text('**Chain:** `t1` seq `1`\n', encoding='utf-8')
    out = run('gather.py', 't1', cwd=repo)
    sect = out.split("--- chain candidates for 't1'")[1]
    assert sect.index('HANDOFF_t1_a') < sect.index('HANDOFF_t1_b')
    assert '- step two' in out
```
(`make_repo(path)` — fixture variant of `repo` that creates the given path; add it to conftest.)
- [ ] **Step 3: run** `python3 -m pytest plugins/handoff/tests -q` → FAIL (no gather.py).
- [ ] **Step 4: implement `gather.py`** — a line-for-line port of the user's `~/.claude/skills/handoff/scripts/gather.sh` (read it; it is the user's own code) with these changes: Python stdlib only (`subprocess.run([...], capture_output=True, text=True, encoding='utf-8')`, `pathlib`, `secrets.token_hex(4)`); git called as `['git', '-C', str(root), ...]`; handoff folder by `pick_handoff_dir(root, is_git)` as in spec F-10 (no git: `<cwd>/docs/handoffs`; git: the first existing of the four candidates, else `docs/superpowers/handoffs` if `docs/superpowers` exists, else `docs/handoffs`; a NEW folder is never under `.claude/`); `print` with `sys.stdout.reconfigure(encoding='utf-8')` at start (Windows console). Candidates for a chain tag: files `HANDOFF_*.md` whose first `**Chain:**` header line names the tag as a whole token; auto-handoffs (`**Auto:** true`) are full chain members and are NOT excluded; sorted by the integer after `seq` (missing → 0); print the newest candidate's `## Where We're Going` section (max 15 non-empty lines).
- [ ] **Step 5: `index.py`** — copy the user's `~/.claude/skills/handoff/scripts/index.py` verbatim, plus `sys.stdout.reconfigure(encoding='utf-8')`. Tests `test_index.py`:
```python
def test_index_appends_exactly_n(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    paths = []
    for i in range(3):
        p = h / f'HANDOFF_t_x{i}_2026-10-08.md'; p.write_text('x\n' * (i + 1), encoding='utf-8'); paths.append(p)
        run('index.py', str(p), 't', str(i + 1), '2026-10-08', 'IN PROGRESS', 'тема ' * 30, 'дальше ' * 30, cwd=repo)
    idx = (h / 'INDEX.md').read_text(encoding='utf-8').splitlines()
    entries = [l for l in idx if l.startswith('- [')]
    assert len(entries) == 3
    assert all(len(l) <= 200 for l in entries)
    assert [p.name in e for p, e in zip(paths, entries)] == [True, True, True]

def test_index_missing_handoff_fails(repo, run_fail):
    assert 'ERROR: handoff file not found' in run_fail('index.py', str(repo / 'nope.md'), 't', '1', 'd', 's', 'a', 'b', cwd=repo)
```
(`run_fail` — fixture returning stderr+stdout of a non-zero run.)
- [ ] **Step 6: run → PASS**; mutation: change dir order in `pick_handoff_dir` (put `.claude/handoffs` first) → `test_gather_prefers_existing_dir_order` FAILS; revert.
- [ ] **Step 7: commit** `feat(handoff): cross-platform gather and index scripts`.

---

### Task 5: commit.py — silent commit with secret filter (F-12)

**Files:**
- Create: `plugins/handoff/skills/handoff/scripts/commit.py`, `plugins/handoff/tests/test_commit.py`

**Interfaces:**
- Produces: `commit.py HANDOFF_PATH --message-file MSG_FILE [--files F1 F2 ...]`. Always exit 0 unless arguments are wrong. Prints any of: `COMMITTED: <short hash>`, `COMMIT_SKIPPED: not a git repository`, `COMMIT_FAILED: <reason>`, `SKIPPED_SECRET: <path>`, `SKIPPED_IGNORED: <path>`, `SKIPPED_MISSING: <path>`, `SKIPPED_UNRELATED: <path>`. Function `is_secret(path: str) -> bool`.

- [ ] **Step 1: failing tests `test_commit.py`**
```python
import subprocess

def git(repo, *a):
    return subprocess.run(['git', '-C', str(repo), *a], capture_output=True, text=True, encoding='utf-8').stdout

def setup(repo):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    hp = h / 'HANDOFF_t_x_2026-10-08.md'; hp.write_text('# h\n', encoding='utf-8')
    (h / 'INDEX.md').write_text('# Handoff Index\n', encoding='utf-8')
    msg = repo.parent / 'msg.txt'; msg.write_text('session: x [t]\n', encoding='utf-8')
    return hp, msg

def test_commits_session_files_only(repo, run):
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    (repo / 'other.txt').write_text('not mine', encoding='utf-8')
    out = run('commit.py', str(hp), '--message-file', str(msg), '--files', 'a.txt', cwd=repo)
    assert 'COMMITTED:' in out
    assert 'SKIPPED_UNRELATED: other.txt' in out
    assert sorted(git(repo, 'show', '--name-only', '--format=', 'HEAD').split()) == \
        ['.claude/handoffs/HANDOFF_t_x_2026-10-08.md', '.claude/handoffs/INDEX.md', 'a.txt']

def test_secrets_never_committed(repo, run):
    hp, msg = setup(repo)
    for n in ['.env', '.env.local', 'prod.key', 'cert.pem', 'aws_credentials.json', 'my-secret.txt', 'id_rsa']:
        (repo / n).write_text('s', encoding='utf-8')
    out = run('commit.py', str(hp), '--message-file', str(msg), '--files',
              '.env', '.env.local', 'prod.key', 'cert.pem', 'aws_credentials.json', 'my-secret.txt', 'id_rsa', cwd=repo)
    assert out.count('SKIPPED_SECRET:') == 7
    assert sorted(git(repo, 'show', '--name-only', '--format=', 'HEAD').split()) == \
        ['.claude/handoffs/HANDOFF_t_x_2026-10-08.md', '.claude/handoffs/INDEX.md']

def test_not_a_secret(repo):
    from importlib import util
    import sys
    from pathlib import Path
    p = Path(__file__).parents[1] / 'skills/handoff/scripts/commit.py'
    spec = util.spec_from_file_location('commit_mod', p); m = util.module_from_spec(spec); spec.loader.exec_module(m)
    assert [m.is_secret(x) for x in ['src/keyboard.ts', 'docs/secrets-policy-ru.md', 'README.md', 'config/.env.example']] == [False, True, False, True]

def test_ignored_handoff_reported(repo, run):
    (repo / '.gitignore').write_text('.claude/\n', encoding='utf-8')
    git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ignore')
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    out = run('commit.py', str(hp), '--message-file', str(msg), '--files', 'a.txt', cwd=repo)
    assert 'SKIPPED_IGNORED: .claude/handoffs/HANDOFF_t_x_2026-10-08.md' in out
    assert 'COMMITTED:' in out
    assert git(repo, 'show', '--name-only', '--format=', 'HEAD').split() == ['a.txt']

def test_no_git(tmp_path, run):
    hp = tmp_path / 'H.md'; hp.write_text('x', encoding='utf-8')
    msg = tmp_path / 'm.txt'; msg.write_text('m', encoding='utf-8')
    assert run('commit.py', str(hp), '--message-file', str(msg), cwd=tmp_path).strip() == 'COMMIT_SKIPPED: not a git repository'

def test_hook_rejects_commit(repo, run):
    hp, msg = setup(repo)
    hook = repo / '.git/hooks/pre-commit'; hook.write_text('#!/bin/sh\necho nope >&2\nexit 1\n'); hook.chmod(0o755)
    out = run('commit.py', str(hp), '--message-file', str(msg), cwd=repo)
    assert 'COMMIT_FAILED:' in out and 'nope' in out

def test_commit_cyrillic_space(tmp_path, run, make_repo):
    r = make_repo(tmp_path / 'Мои проекты' / 'сайт')
    hp, msg = setup(r)
    (r / 'файл с пробелом.txt').write_text('x', encoding='utf-8')
    out = run('commit.py', str(hp), '--message-file', str(msg), '--files', 'файл с пробелом.txt', cwd=r)
    assert 'COMMITTED:' in out
    assert 'файл с пробелом.txt' in git(r, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD')
```
`test_hook_rejects_commit` is skipped on Windows (`pytest.mark.skipif(os.name == 'nt')`).
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement `commit.py`**
```python
#!/usr/bin/env python3
"""Silent handoff commit: the handoff, INDEX.md and the session's own files — never secrets.

Usage: commit.py HANDOFF_PATH --message-file MSG [--files F ...]
Always exits 0 (a failed commit must not stop the handoff); every outcome is one printed line.
"""
import argparse
import fnmatch
import subprocess
import sys
from pathlib import Path

SECRET = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*',
          '*credentials*', '*secret*', '*.keystore']


def is_secret(path: str) -> bool:
    name = Path(path).name.lower()
    return any(fnmatch.fnmatch(name, p) for p in SECRET)


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), '-c', 'core.quotepath=false', *args],
                          capture_output=True, text=True, encoding='utf-8')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('handoff')
    ap.add_argument('--message-file', required=True)
    ap.add_argument('--files', nargs='*', default=[])
    a = ap.parse_args()

    top = git(Path(a.handoff).resolve().parent, 'rev-parse', '--show-toplevel')
    if top.returncode != 0:
        print('COMMIT_SKIPPED: not a git repository')
        return
    root = Path(top.stdout.strip())
    handoff = Path(a.handoff).resolve()
    wanted = [handoff, handoff.parent / 'INDEX.md'] + [(root / f).resolve() for f in a.files]

    picked = []
    for p in wanted:
        try:
            rel = p.relative_to(root).as_posix()
        except ValueError:
            rel = str(p)
        if is_secret(rel) and p != handoff:
            print(f'SKIPPED_SECRET: {rel}'); continue
        if git(root, 'check-ignore', '-q', rel).returncode == 0:
            print(f'SKIPPED_IGNORED: {rel}'); continue
        tracked = git(root, 'ls-files', '--error-unmatch', rel).returncode == 0
        if not p.exists() and not tracked:
            print(f'SKIPPED_MISSING: {rel}'); continue
        if rel not in picked:
            picked.append(rel)

    status = git(root, 'status', '--porcelain', '-z').stdout.split('\0')
    for entry in status:
        rel = entry[3:]
        if rel and rel not in picked and not rel.startswith(tuple(x + '/' for x in picked)):
            print(f'SKIPPED_UNRELATED: {rel}')

    if not picked:
        print('COMMIT_FAILED: nothing to commit'); return
    add = git(root, 'add', '--', *picked)
    if add.returncode != 0:
        print(f'COMMIT_FAILED: {add.stderr.strip().splitlines()[-1] if add.stderr.strip() else "git add failed"}'); return
    msg = Path(a.message_file).read_text(encoding='utf-8')
    c = subprocess.run(['git', '-C', str(root), 'commit', '-q', '-F', '-'],
                       input=msg, capture_output=True, text=True, encoding='utf-8')
    if c.returncode != 0:
        why = (c.stderr.strip() or c.stdout.strip() or 'git commit failed').splitlines()
        print(f'COMMIT_FAILED: {" | ".join(why[-3:])}'); return
    print(f'COMMITTED: {git(root, "rev-parse", "--short", "HEAD").stdout.strip()}')


if __name__ == '__main__':
    main()
```
- [ ] **Step 4: run → PASS (7 tests).** Mutation: remove `'*secret*'` from `SECRET` → `test_secrets_never_committed` FAILS (count 6); revert.
- [ ] **Step 5: commit** `feat(handoff): silent commit with secret filter`.

---

### Task 6: SKILL.md — generalized skill, auto + manual modes (F-08, F-11, F-13, F-14)

**Files:**
- Create: `plugins/handoff/skills/handoff/SKILL.md`

**Interfaces:**
- Consumes: scripts from Tasks 4–5 (exact CLI above).
- Produces: invocation contract for the mod: `/handoff:handoff auto <ABS_PATH>` → writes exactly `<ABS_PATH>`, last output line `HANDOFF_DONE: <ABS_PATH>`; never asks questions in auto mode. Paste prompt text identical to Task 8 `pastePrompt`.

- [ ] **Step 1: write SKILL.md.** Start from the user's `~/.claude/skills/handoff/SKILL.md` (read it; user's own text) and produce the generalized version with exactly these differences:
  - frontmatter: `name: handoff`, same `description` triggers, `argument-hint: "[auto <path> | reason]"`, `user-invocable: true`. No `disable-model-invocation` (users ask for handoffs in words).
  - **Scripts:** "Scripts live in `scripts/` next to this file — the base directory is printed when this skill loads (`Base directory for this skill: …`). Run them with `python3 -I "<base>/scripts/<name>.py"` on macOS and `py -3 -I "<base>\scripts\<name>.py"` on Windows (fall back to `python -I` if `py` is missing)."
  - Step 1 uses `gather.py`; Step 4 uses `index.py`; remove the Cost Model's dated measurements (keep the 3-turn budget and 250-line ceiling, drop "Measured over 94 runs…"), remove `HARNESS-CHANGES-LOG.md`, Kimi Code, `measure-cost.py`, MEMORY.md mentions.
  - `NOT_GIT: yes` → **do not ask**: write into the printed `HANDOFF_DIR`, skip the commit, say so in the report.
  - **Mode switch section** (new, right after Guards):
    - `$ARGUMENTS` starts with `auto ` → AUTO MODE: the rest is the absolute target path. Write the handoff to exactly that path (create folders). Ask nothing. Header gets an extra line `**Auto:** true`. After index, run commit (Step 5). The final line of the reply is exactly `HANDOFF_DONE: <path>`. No paste prompt, no close question — the mod opens the new session.
    - otherwise → MANUAL MODE: path chosen as in the original (`HANDOFF_{chain_tag}_{slug}_{YYYY-MM-DD}.md`), same Steps, then commit silently, then print the paste prompt and "Open a new session (terminal: run `claude` in this folder; app: ⌘N / Ctrl+N) and paste it."
  - **Step 5 replaced by silent commit:** append the `## Session Closed` block, write the commit message to a temp file (`session: {slug} [{chain_tag}]` + summary + `Handoff: {filename}` + `Chain: …` + the attribution trailer from the system reminder/project CLAUDE.md, if any), run `commit.py "<handoff>" --message-file "<msg>" --files <every file this session created or changed, repo-relative>`. Report `COMMITTED:` / `COMMIT_SKIPPED:` / `COMMIT_FAILED:` and every `SKIPPED_SECRET:` line to the user; on `COMMIT_FAILED` also append `**Commit failed:** <reason>` to the handoff. Remove the Yes/No close question entirely.
  - **Python missing fallback:** if the script command fails with "not found"/"is not recognized", do the same with plain `git` commands (`git rev-parse --show-toplevel`, `git status -s`, `git log --oneline -15`), append the INDEX line by hand (≤ 200 chars), and `git add` only the handoff, INDEX.md and session files — never files matching the secret patterns listed in `commit.py`.
  - **Paste prompt (manual mode)** — Russian, exactly:
```
Прочитай `{absolute path}` (seq {N}, {chain_tag}) и продолжи работу с раздела «Where We're Going».

Прежде чем начинать:
1. Перескажи в 5–8 строках: цель, текущее состояние, что пробовали и что не вышло
2. Прочитай ТОЛЬКО файлы из «Must-read» в Quick Start
3. Скажи, что проверишь первым и каким будет первый шаг
Потом жди моего «поехали».
```
  - The gather rule "Session began with a pasted `(seq N, {tag})` prompt" also matches this Russian prompt (`(seq N, tag)` is kept verbatim for that reason).
- [ ] **Step 2: check** — `/usr/bin/grep -nE "HARNESS|Kimi|measure-cost|MEMORY.md|~/.claude/skills" plugins/handoff/skills/handoff/SKILL.md` → no output. `claude plugin validate .../plugins/handoff` → passed, lists skill `handoff`.
- [ ] **Step 3: commit** `feat(handoff): generalized skill with auto and manual modes`.

---

### Task 7: handoff mod — pure logic (F-14, F-15, F-17 path, F-18…F-21 argv)

**Files:**
- Create: `plugins/handoff/hooks/logic.ts`, `plugins/handoff/tests/logic.test.ts`

**Interfaces:**
- Produces (all used by Task 8):
  - `type Trigger = { askAt: number; armed: boolean }`
  - `initialTrigger(base: number): Trigger`
  - `measure(t: Trigger, pct: number, base: number): { next: Trigger; ask: boolean }`
  - `snooze(pct: number, step: number): Trigger`
  - `startedTrigger(t: Trigger): Trigger`
  - `pickHandoffDir(root: string, exists: (p: string) => boolean, isGit: boolean): string`
  - `stamp(ms: number): string` → `YYYY-MM-DD-HHMMSS` local
  - `autoPath(dir: string, ms: number): string` → `<dir>/HANDOFF_auto_<stamp>.md`
  - `parseChain(text: string): { tag: string; seq: number } | null`
  - `pastePrompt(path: string, chain: { tag: string; seq: number } | null): string`
  - `shq(s: string): string` (POSIX single-quote)
  - `macCommandScript(root: string, bin: string, prompt: string): string`
  - `windowsPrompt(prompt: string): string` (one line, no `"&|<>^%`)
  - `windowsArgv(hasWt: boolean, root: string, bin: string, prompt: string): string[]`
  - `openUrlArgv(isWindows: boolean, url: string): string[]`
  - `isWrittenSince(mtimeMs: number | undefined, startedAt: number): boolean` (2 s tolerance)

- [ ] **Step 1: failing tests `logic.test.ts`**
```ts
import { test, expect } from 'claude-code/testing'
import * as L from '../hooks/logic'

test('threshold 59/60/61', () => {
  const t = L.initialTrigger(60)
  expect(L.measure(t, 59, 60).ask).toBe(false)
  expect(L.measure(t, 60, 60).ask).toBe(true)
  expect(L.measure(t, 61, 60).ask).toBe(true)
})

test('snooze twice: 60 → 70 → 80', () => {
  let t = L.snooze(60, 10)
  expect(t).toEqual({ askAt: 70, armed: true })
  expect(L.measure(t, 69, 60).ask).toBe(false)
  expect(L.measure(t, 70, 60).ask).toBe(true)
  t = L.snooze(70, 10)
  expect(t.askAt).toBe(80)
})

test('jump over threshold snoozes from current value', () => {
  expect(L.measure(L.initialTrigger(60), 83, 60).ask).toBe(true)
  expect(L.snooze(83, 10).askAt).toBe(93)
})

test('after start: no ask until context drops below base, then re-armed at base', () => {
  let t = L.startedTrigger(L.initialTrigger(60))
  expect(L.measure(t, 90, 60).ask).toBe(false)
  const r = L.measure(t, 12, 60)
  expect(r.ask).toBe(false)
  expect(r.next).toEqual({ askAt: 60, armed: true })
  expect(L.measure(r.next, 60, 60).ask).toBe(true)
})

test('pickHandoffDir order and defaults', () => {
  const has = (...xs: string[]) => (p: string) => xs.includes(p)
  expect(L.pickHandoffDir('/r', has('/r/plans/handoffs', '/r/.claude/handoffs'), true)).toBe('/r/plans/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/superpowers'), true)).toBe('/r/docs/superpowers/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/docs/handoffs', '/r/.claude/handoffs'), true)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/.claude/handoffs'), true)).toBe('/r/.claude/handoffs')
  expect(L.pickHandoffDir('/r', has(), true)).toBe('/r/docs/handoffs')
  expect(L.pickHandoffDir('/r', has('/r/plans/handoffs'), false)).toBe('/r/docs/handoffs')
})

test('autoPath stamp is local time', () => {
  const ms = new Date(2026, 9, 8, 9, 5, 7).getTime()
  expect(L.autoPath('/r/.claude/handoffs', ms)).toBe('/r/.claude/handoffs/HANDOFF_auto_2026-10-08-090507.md')
})

test('parseChain', () => {
  expect(L.parseChain('# x\n**Chain:** `standalone-ab12cd34` seq `3`\n')).toEqual({ tag: 'standalone-ab12cd34', seq: 3 })
  expect(L.parseChain('no header')).toBe(null)
})

test('pastePrompt with and without chain', () => {
  const p = L.pastePrompt('/r/H.md', { tag: 't', seq: 2 })
  expect(p.split('\n')[0]).toBe('Прочитай `/r/H.md` (seq 2, t) и продолжи работу с раздела «Where We\'re Going».')
  expect(p.endsWith('Потом жди моего «поехали».')).toBe(true)
  expect(L.pastePrompt('/r/H.md', null).split('\n')[0]).toBe('Прочитай `/r/H.md` и продолжи работу с раздела «Where We\'re Going».')
})

test('shq and macCommandScript survive quotes, spaces, Cyrillic', () => {
  expect(L.shq("it's")).toBe(`'it'\\''s'`)
  const s = L.macCommandScript('/Users/Иван/Мои проекты/сайт', '/usr/local/bin/claude', "Прочитай `x` и 'жди'")
  expect(s).toBe(`#!/bin/zsh\ncd '/Users/Иван/Мои проекты/сайт' || exit 1\nexec '/usr/local/bin/claude' 'Прочитай \`x\` и '\\''жди'\\'''\n`)
})

test('windowsPrompt and windowsArgv', () => {
  expect(L.windowsPrompt('a\nb "c" & d | e')).toBe('a b c  d  e')
  expect(L.windowsArgv(true, 'C:\\Проекты\\сайт', 'claude', 'p')).toEqual(['wt', '-d', 'C:\\Проекты\\сайт', 'claude', 'p'])
  expect(L.windowsArgv(false, 'C:\\Проекты\\сайт', 'claude', 'p')).toEqual(['cmd', '/c', 'start', '', '/D', 'C:\\Проекты\\сайт', 'claude', 'p'])
})

test('openUrlArgv', () => {
  expect(L.openUrlArgv(false, 'claude://resume?session=1')).toEqual(['open', 'claude://resume?session=1'])
  expect(L.openUrlArgv(true, 'claude://resume?session=1')).toEqual(['rundll32', 'url.dll,FileProtocolHandler', 'claude://resume?session=1'])
})

test('isWrittenSince: old file is not a written handoff', () => {
  expect(L.isWrittenSince(undefined, 10_000)).toBe(false)
  expect(L.isWrittenSince(5_000, 10_000)).toBe(false)
  expect(L.isWrittenSince(8_000, 10_000)).toBe(true)
  expect(L.isWrittenSince(12_000, 10_000)).toBe(true)
})
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement `logic.ts`**
```ts
export type Trigger = { askAt: number; armed: boolean }
export type Chain = { tag: string; seq: number }

export const initialTrigger = (base: number): Trigger => ({ askAt: base, armed: true })

export function measure(t: Trigger, pct: number, base: number): { next: Trigger; ask: boolean } {
  if (pct < base) return { next: { askAt: base, armed: true }, ask: false }
  return { next: t, ask: t.armed && pct >= t.askAt }
}

export const snooze = (pct: number, step: number): Trigger => ({ askAt: Math.round(pct) + step, armed: true })
export const startedTrigger = (t: Trigger): Trigger => ({ ...t, armed: false })

const DIRS = ['docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs']

export function pickHandoffDir(root: string, exists: (p: string) => boolean, isGit: boolean): string {
  if (!isGit) return `${root}/docs/handoffs`
  for (const d of DIRS) if (exists(`${root}/${d}`)) return `${root}/${d}`
  return exists(`${root}/docs/superpowers`) ? `${root}/docs/superpowers/handoffs` : `${root}/docs/handoffs`
}

const p2 = (n: number) => String(n).padStart(2, '0')
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}
export const autoPath = (dir: string, ms: number) => `${dir}/HANDOFF_auto_${stamp(ms)}.md`

export function parseChain(text: string): Chain | null {
  const m = /\*\*Chain:\*\*\s*`([^`]+)`\s*seq\s*`?(\d+)/.exec(text)
  return m ? { tag: m[1], seq: Number(m[2]) } : null
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

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const macCommandScript = (root: string, bin: string, prompt: string) =>
  `#!/bin/zsh\ncd ${shq(root)} || exit 1\nexec ${shq(bin)} ${shq(prompt)}\n`

export const windowsPrompt = (prompt: string) => prompt.replace(/[\r\n]+/g, ' ').replace(/["&|<>^%]/g, '')

export const windowsArgv = (hasWt: boolean, root: string, bin: string, prompt: string): string[] =>
  hasWt ? ['wt', '-d', root, bin, prompt] : ['cmd', '/c', 'start', '', '/D', root, bin, prompt] // no nested `cmd /k`: it cuts the quotes when the path to claude has a space (F-19)

export const openUrlArgv = (isWindows: boolean, url: string): string[] =>
  isWindows ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['open', url]

export const isWrittenSince = (mtimeMs: number | undefined, startedAt: number) =>
  mtimeMs !== undefined && mtimeMs >= startedAt - 2000
```
Check the `windowsPrompt` expectation by hand: `'a\nb "c" & d | e'` → newline→space: `a b "c" & d | e` → strip `"&|`: `a b c  d  e` ✔.
- [ ] **Step 4: run → PASS (12 tests).** Mutation: in `measure` drop `t.armed &&` → the "after start" test FAILS; revert.
- [ ] **Step 5: commit** `feat(handoff): trigger logic and launch command builders`.

---

### Task 8: handoff mod — register.ts glue (F-15…F-23)

**Files:**
- Create: `plugins/handoff/tests/register.test.ts`
- Modify: `plugins/handoff/hooks/register.ts` (replace stub), `plugins/handoff/types/index.d.ts`

**Interfaces:**
- Consumes: everything from Task 7; skill contract from Task 6 (`handoff:handoff`, `auto <path>`); options `threshold`, `step`.
- Produces: command `/handoff-now`; store keys `p:<sessionId>` (`Pending`), `t:<sessionId>` (`Trigger`).

- [ ] **Step 1: contract `types/index.d.ts`**
```ts
export type Pending = { path: string; startedAt: number; root: string; writeTurnId: string | null }
export {}
```
(no `$.state` used — the mod keeps state in `$.store` because it must survive the app putting a chat to sleep; if `claude plugin validate` asks for a `PluginState` declaration, add `declare module 'claude-code' { interface PluginState { handoff: {} } }`.)
- [ ] **Step 2: failing tests `register.test.ts`** — use `mock.clock`, `mock.store`, `mock.env`, and test-level hooks beneath the plugin for `ui.ask`, `command.run`, `process.run`, `fs.stat`, `fs.read`, `fs.write`, `ui.copy`, `ui.toast` (look up each event's input/result in the types; a test's `on('<event>', ...)` answers it). Cases, each asserting concrete values:
  1. `session.measure` with `percent: 59` → `ui.ask` never called; with `60` → called once with text `Контекст 60%. Передать работу в новую сессию?` and options `['Передать', 'Не сейчас']`.
  2. Answer `Не сейчас` at 60 → measure 69 no ask; 70 → ask again.
  3. Answer `Передать` → `command.run` received `{ command: 'handoff:handoff', args: 'auto <root>/docs/handoffs/HANDOFF_auto_<stamp>.md' }` (root from a mocked `git rev-parse --show-toplevel` = `/r`, clock at `new Date(2026,9,8,9,5,7)`).
  4. **old file is not a written handoff:** `fs.stat` returns `mtimeMs = startedAt - 60_000` → after `turn.complete` of the write turn: toast `Хендофф не записан — ничего не закрыто`, no `process.run` launching anything, no `command.run('exit')`.
  5. Terminal Mac happy path: env without `OS`, surfaces `['terminal']`; file written (`mtimeMs = startedAt + 5000`), content has `**Chain:** \`t\` seq \`2\`` → `fs.write` of a `.command` file whose content equals `macCommandScript('/r', 'claude', pastePrompt(path, {tag:'t',seq:2}))`; `process.run(['chmod','+x',file])`, `process.run(['open', file])` exit 0 → THEN `command.run({ command: 'exit' })`. Assert the order: `open` before `exit`.
  6. Terminal Mac, `open` returns exit 1 → `ui.copy` with the prompt, toast contains `⌘N`, and `command.run('exit')` is NEVER called.
  7. Windows terminal: env `OS=Windows_NT`, `where wt` exit 1 → `process.run` got `windowsArgv(false, root, 'claude', windowsPrompt(prompt))`.
  8. Desktop: surfaces `['desktop']` → first `process.run` argv starts `['claude','-p','--session-id']` with `--permission-mode plan` and `stdin` equal to the prompt and `cwd` `/r`; then `['open','claude://resume?session=<same uuid>']`; app record never appears within 60 mocked seconds → `ui.copy` + toast; `command.run('exit')` never called.
  9. `/handoff-now` while pending → returns text `Передача уже идёт: <path>`; `command.run('handoff:handoff')` called once in total.
  10. Restart: store pre-filled with `p:<sid>` whose file exists and is fresh → on `session.start` the launch step runs (case-5 assertions).
  11. Timeout: 15 mocked minutes pass with no file → toast `Хендофф не дождались — ничего не закрыто`; store key removed.
- [ ] **Step 3: run → FAIL.**
- [ ] **Step 4: implement `register.ts`**
```ts
import type { Register } from 'claude-code'
import type { Pending } from '../types'
import * as L from './logic'

const WAIT_MS = 15 * 60_000
const APP_WAIT_SEC = 60
const MARK_TTL = 30 * 24 * 60 * 60_000

export const register: Register = (on, options: any) => {
  const base = Number(options?.threshold ?? 60)
  const step = Number(options?.step ?? 10)
  let sid = ''
  let isAsking = false
  let trigger: L.Trigger = L.initialTrigger(base)
  let pending: Pending | null = null

  const savePending = async ($: any) => (pending ? $.store.set(`p:${sid}`, pending) : $.store.delete(`p:${sid}`))
  const saveTrigger = async ($: any) => $.store.set(`t:${sid}`, { ...trigger, at: await $.clock.now() })
  const isWindows = async ($: any) => (await $.env.get('OS')) === 'Windows_NT'
  const claudeBin = async ($: any) => (await $.env.get('CLAUDE_CODE_EXECPATH'))?.trim() || 'claude'
  const toastFallback = async ($: any, prompt: string, why: string) => {
    const copied = await $.ui.copy({ text: prompt }).catch(() => ({ isCopied: false }))
    const keys = (await isWindows($)) ? 'Ctrl+N' : '⌘N'
    $.ui.toast(copied.isCopied
      ? `Новая сессия не открылась сама (${why}). Фраза скопирована: нажми ${keys} и вставь`
      : `Новая сессия не открылась сама (${why}). Открой новую сессию и вставь: ${prompt}`)
  }

  async function projectRoot($: any): Promise<{ root: string; isGit: boolean }> {
    const cwd = await $.session.cwd()
    const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
    return r && r.exitCode === 0 ? { root: r.stdout.trim().replace(/\\/g, '/'), isGit: true } : { root: cwd.replace(/\\/g, '/'), isGit: false }
  }

  async function start($: any) {
    if (pending) return
    const { root, isGit } = await projectRoot($)
    const exists = new Set<string>()
    for (const d of ['docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs', 'docs/superpowers'])
      if (await $.fs.stat(`${root}/${d}`).catch(() => undefined)) exists.add(`${root}/${d}`)
    const now = await $.clock.now()
    const path = L.autoPath(L.pickHandoffDir(root, p => exists.has(p), isGit), now)
    pending = { path, startedAt: now, root, writeTurnId: null }
    trigger = L.startedTrigger(trigger)
    await savePending($); await saveTrigger($)
    void $.clock.after(WAIT_MS + 1000, () => void check($, null))
    await $.command.run({ command: 'handoff:handoff', args: `auto ${path}` })
  }

  async function cancel($: any, msg: string) {
    pending = null
    trigger = { ...trigger, armed: true }
    await savePending($); await saveTrigger($)
    $.ui.toast(`${msg} — ничего не закрыто`)
  }

  async function check($: any, endedTurnId: string | null) {
    const p = pending
    if (!p) return
    const st = await $.fs.stat(p.path).catch(() => undefined)
    if (L.isWrittenSince(st?.mtimeMs, p.startedAt)) return void launch($, p)
    if (endedTurnId && p.writeTurnId === endedTurnId) return cancel($, 'Хендофф не записан')
    if ((await $.clock.now()) - p.startedAt > WAIT_MS) return cancel($, 'Хендофф не дождались')
  }

  async function launch($: any, p: Pending) {
    pending = null
    await savePending($)
    const text = await $.fs.read(p.path).catch(() => '')
    const prompt = L.pastePrompt(p.path, L.parseChain(text))
    const win = await isWindows($)
    const bin = await claudeBin($)
    const surfaces: readonly string[] = await $.session.surfaces()
    let ok = false
    let why = ''
    try {
      if (surfaces.includes('desktop')) {
        const id = crypto.randomUUID()
        const seed = await $.process.run([bin, '-p', '--session-id', id, '--permission-mode', 'plan', '--output-format', 'json'],
          { stdin: prompt, cwd: p.root, timeoutMs: 180_000 })
        if (seed.exitCode !== 0 && !seed.stdout.includes(id)) throw new Error(`фоновый запуск: ${(seed.stderr || seed.stdout).trim().slice(0, 80)}`)
        await $.process.run(L.openUrlArgv(win, `claude://resume?session=${id}`))
        ok = win ? false : await waitAppRecord($, id)
        if (!ok) why = win ? 'Windows: проверить появление чата нельзя' : 'чат не появился за 60 с'
      } else if (win) {
        const hasWt = (await $.process.run(['where', 'wt']).catch(() => ({ exitCode: 1 }))).exitCode === 0
        const r = await $.process.run(L.windowsArgv(hasWt, p.root, bin, L.windowsPrompt(prompt)))
        ok = r.exitCode === 0
        if (!ok) why = 'окно терминала не открылось'
      } else {
        const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
        const file = `${tmp}/claude-kit-handoff-${L.stamp(p.startedAt)}.command`
        await $.fs.write(file, L.macCommandScript(p.root, bin, prompt))
        await $.process.run(['chmod', '+x', file])
        ok = (await $.process.run(['open', file])).exitCode === 0
        if (!ok) why = 'окно терминала не открылось'
      }
    } catch (err: any) {
      why = String(err?.message ?? err).slice(0, 120)
    }
    if (!ok) return toastFallback($, prompt, why)
    if (!surfaces.includes('desktop')) await $.command.run({ command: 'exit' })
  }

  async function waitAppRecord($: any, id: string): Promise<boolean> {
    const home = await $.env.get('HOME')
    const baseDir = `${home}/Library/Application Support/Claude/claude-code-sessions`
    for (let i = 0; i < APP_WAIT_SEC; i++) {
      for (const acct of await $.fs.list(baseDir).catch(() => [])) {
        if (acct.kind !== 'dir') continue
        for (const org of await $.fs.list(`${baseDir}/${acct.name}`).catch(() => [])) {
          if (org.kind === 'dir' && (await $.fs.stat(`${baseDir}/${acct.name}/${org.name}/local_${id}.json`).catch(() => undefined))) return true
        }
      }
      await $.clock.sleep(1000)
    }
    return false
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff-now', description: 'Передать работу в новую сессию сейчас' }) // in every session: the app starts with isInteractive: false and still needs the command
    sid = await $.session.id()
    const now = await $.clock.now()
    const t = await $.store.get(`t:${sid}`)
    if (t) trigger = { askAt: t.askAt, armed: t.armed }
    pending = (await $.store.get(`p:${sid}`)) ?? null
    for (const k of await $.store.keys()) {
      const v: any = await $.store.get(k)
      if (now - (v?.at ?? v?.startedAt ?? 0) > MARK_TTL) await $.store.delete(k)
    }
    if (pending) void $.clock.after(2000, () => void check($, null))
    return next(e)
  })

  on('command.run', { command: 'handoff-now' }, async $ => {
    if (pending) return { text: `Передача уже идёт: ${pending.path}` }
    void start($)
    return { text: 'Пишу хендофф; потом коммит и новая сессия' }
  })

  on('turn.start', async ($, e, next) => {
    if (pending && !pending.writeTurnId && e.text?.includes(pending.path)) {
      pending = { ...pending, writeTurnId: e.turnId }
      await savePending($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await check($, e.turnId)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const pct = e.context?.percent
    if (pct === undefined || pending || isAsking) return next(e)
    const r = L.measure(trigger, pct, base)
    trigger = r.next
    if (r.ask && (await $.session.surfaces()).length > 0) {
      isAsking = true
      void (async () => {
        try {
          const a = await $.ui.ask(`Контекст ${Math.round(pct)}%. Передать работу в новую сессию?`,
            { header: 'Контекст', options: ['Передать', 'Не сейчас'] })
          if (a === 'Передать') await start($)
          else { trigger = L.snooze(pct, step); await saveTrigger($) }
        } catch {
          trigger = L.snooze(pct, step); await saveTrigger($)
        } finally { isAsking = false }
      })()
    }
    return next(e)
  })
}
```
Notes for the implementer: (a) `$.ui.copy` — pass `surface` per the types if required; (b) if `$.clock.sleep` inside `launch` burns the hook budget (reference.md "Work that outlives a dispatch"), run `launch` from `$.clock.after(0, ...)` so it is timer-owned, not hook-owned; (c) apply probe S-0 results: if Step 3 showed the chat stuck in `plan`, seed with `--permission-mode default`; if Step 4 showed `exit` does not end the session, replace it with the method the probe found and update test 5.
- [ ] **Step 5: run → PASS (11 tests).** Mutation: move `await $.command.run({ command: 'exit' })` above the `if (!ok)` line → test 6 FAILS; revert.
- [ ] **Step 6: validate + tsc** — `claude plugin validate .../plugins/handoff` passed; `tsc` clean.
- [ ] **Step 7: commit** `feat(handoff): trigger mod opens a new session and closes the old one last`.

---

### Task 9: Live verification on Mac (orchestrator + user, NOT a subagent) — F-07, F-18, F-20, F-22

**Files:**
- Create: `docs/screens/ctx-terminal.png`, `docs/screens/ctx-desktop.png`, `docs/screens/handoff-terminal.png`, `docs/screens/handoff-desktop.png`, `docs/live-check.md`

- [ ] **Step 1:** install for the user (asks first): `claude plugin marketplace add <repo>`, `claude plugin install ctx@claude-kit`, `claude plugin install handoff@claude-kit` (user approves; their Vels `handoffvels` stays — note the two `/handoff-now` commands collide: disable `handoffvels` for the duration and say so).
- [ ] **Step 2: terminal run** in a scratch git repo: band visible (screenshot); `/handoff-now` → handoff file written, commit present (`git log -1 --name-only`), new Terminal window with the summary, old session exited, `claude --resume` lists it (screenshot).
- [ ] **Step 3: app run** — same in the Code tab (screenshots): new chat appears with the summary, «поехали» lets it edit, old chat still in the list.
- [ ] **Step 4: fallback A** — not forced live (forcing it would mean tampering with the user's app data folder). Proof = unit tests Task 8 cases 6 and 8; record that in `docs/live-check.md`.
- [ ] **Step 5:** write `docs/live-check.md` (what was run, results, screenshot names) and commit `docs: live check on macOS`.

---

### Task 10: README, Windows checklist, traceability (F-02, F-19 marking)

**Files:**
- Create: `README.md`, `docs/windows-checklist.md`, `docs/traceability.md`

- [ ] **Step 1: README.md (Russian)** sections: «Что это» (two plugins, one line each + screenshot links); «Что нужно» (Claude Code ≥ 2.1.293 — `claude --version`; Git; Python 3 — Mac: есть или ставится с Xcode Command Line Tools, Windows: python.org, галочка «Add to PATH»); «Установка» — in a terminal:
```
claude plugin marketplace add bonosurgut/claude-kit
claude plugin install ctx@claude-kit
claude plugin install handoff@claude-kit
```
then «открой новую сессию»; «Как пользоваться» (шкалы; вопрос на 50%; `/handoff-now`; ручной `/handoff:handoff`; что делает «Передать»: хендофф → коммит без секретов → новая сессия → «поехали»); «Настройки» (table from spec F-24; `/plugin` → Installed → plugin → настройки); «Выключить» (`/plugin` → Disable); «Windows» — «Не проверено вживую. Если что-то не так — пройдите `docs/windows-checklist.md` и напишите автору»; «Благодарности» — «Идеи шкал и вопроса на пороге контекста — из модов Никиты Велса. Код написан заново.»; «Лицензия» — MIT.
- [ ] **Step 2: `LICENSE`** — MIT, `Copyright (c) 2026 bonosurgut`. (Lets clients and others reuse it — the opposite of the situation with the Vels archive.)
- [ ] **Step 3: `docs/windows-checklist.md`** — numbered manual checks with expected result each: install commands; band visible; `py -3 --version`; `/handoff-now` in Windows Terminal → new window opens in the project folder; same in `cmd` without Windows Terminal; path with Cyrillic and spaces; app: new chat appears, else clipboard fallback + Ctrl+N; old session behaviour; secret file `.env` not committed.
- [ ] **Step 4: `docs/traceability.md`** — table `ID | фича | файлы | проверка | статус` for F-01…F-24, filled from Tasks 2–9 (tests by file::name, screenshots by path). F-19 and the Windows half of F-20 → `partial (не проверено вживую)`.
- [ ] **Step 5:** `claude plugin validate <repo>` passed; all tests: `claude plugin test plugins/ctx`, `claude plugin test plugins/handoff`, `python3 -m pytest plugins/handoff/tests -q` — all green, counts written into the traceability header.
- [ ] **Step 6: commit** `docs: README, Windows checklist, traceability`.

---

### Task 11: Final review + publish gate

- [ ] **Step 1:** dispatch `final-cohesion-reviewer` over the whole repo with spec + plan + `docs/traceability.md`.
- [ ] **Step 2:** fix findings via `fix-round-reviewer` rounds.
- [ ] **Step 3: STOP — ask the user** before `gh repo create bonosurgut/claude-kit --public --source . --push`. Publishing is outward-facing and needs an explicit yes in chat.
