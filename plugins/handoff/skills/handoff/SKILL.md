---
name: handoff
description: Use when context is running low, work is pausing, ending the day, or you need to capture session state so a fresh session can continue without re-investigation. Triggers on "do a handoff", "create a handoff", "run handoff", "save session", "save session progress", "session handoff", "running out of context", "wrap up", "wrap up for the day", "done for the day", "end of day", "pausing work", "continue in a fresh session". Do NOT trigger when the user is only discussing, asking about, or editing an existing handoff file — ask first if ambiguous.
user-invocable: true
argument-hint: "[auto <path> | reason]"
allowed-tools:
  - Bash(python3 -I *handoff*gather.py*)
  - Bash(python3 -I *handoff*index.py*)
  - Bash(python3 -I *handoff*commit.py*)
  - Bash(py -3 -I *handoff*gather.py*)
  - Bash(py -3 -I *handoff*index.py*)
  - Bash(py -3 -I *handoff*commit.py*)
  - Bash(python -I *handoff*gather.py*)
  - Bash(python -I *handoff*index.py*)
  - Bash(python -I *handoff*commit.py*)
  - Write(//**/HANDOFF_*.md)
  - Edit(//**/HANDOFF_*.md)
  - Write(//**/handoff-commit-msg-*.txt)
---

# Session Handoff

Git-native: git + an in-repo handoff chain + `INDEX.md`. No issue tracker, no vector memory, no subagents.
`/handoff:handoff` alone is sufficient — the user provides nothing else.

**Arguments:** $ARGUMENTS (`auto <absolute path>` — see Mode switch; anything else is a framing hint, the conversation is ground truth)

**Scripts** live in `scripts/` next to this file — the base directory is printed when this skill loads (`Base directory for this skill: …`). Run them with `python3 -I "<base>/scripts/<name>.py"` on macOS/Linux and `py -3 -I "<base>\scripts\<name>.py"` on Windows (fall back to `python -I` if `py` is missing). The steps below show the macOS/Linux form. If Python itself is missing, see the last section.

**Guards:**
- **Not plan mode** — this skill writes files; exit plan mode first. (In auto mode nobody can answer: write nothing, say in one line that plan mode blocked the handoff, and do not print `HANDOFF_DONE`.)
- **Not shadowing** — never produce handoff-like documents freeform; only this skill writes handoffs (chain tracking, index, commit).
- **Not when discussing** — run only when the user asks to CREATE a handoff now. Ambiguous ("what does handoff do", "edit the handoff") → ask. (Auto mode is itself the request — never ask there.)

## Mode switch — decide before Step 1

Look at the Arguments line above.

**AUTO MODE** — it starts with `auto ` and the rest is an absolute path (`/…`, `C:\…`, `C:/…` or `\\…`). This is how the handoff mod calls the skill; a hint such as "auto save before lunch" is not an auto-mode call.
- The target path is the rest, taken literally except for surrounding whitespace (it may contain spaces). Write the handoff to exactly that path — not under a name of your own — creating missing folders.
- **Look up the chain parent, the seq and the git state in the folder of the target path**, not in the folder you happen to be in. The session may have moved since it started (a `cd` into a nested repository, for example), so Step 1 hands that folder to gather with `--handoff-dir`.
- **Ask nothing, ever.** Nobody is there to answer, and a question stalls the whole handoff. Wherever the steps below say "ask", take the default: continuation unclear → new chain; no date in context → the date from the file name (Step 3). `NOT_GIT` never asks, in either mode.
- The file is the same as in manual mode, header included: an auto handoff is an ordinary chain member that a later session may continue, and the mod reads tag and seq from the `**Chain:**` line, so keep that line exactly in the template's form.
- Run the same steps, with the commit (Step 5) after the index (Step 4).
- No paste prompt, no tip about opening a session — the mod opens the new session.
- The reply ends with `HANDOFF_DONE: <path>` — the path exactly as given, on the very last line, nothing after it. Print it only once the file is written; if the file could not be written, say why in one line and do not print it. A failed commit does not stop it — the failure is reported above that line.

**MANUAL MODE** — everything else (empty, or a hint such as "context low"). Same steps; Step 3 chooses the path (`HANDOFF_{chain_tag}_{slug}_{YYYY-MM-DD}.md`); after the commit, Step 6 prints the paste prompt and the tip.
- **Look up the chain parent, the seq, the git state and the handoff folder in the folder the session started in** (the session root), not in the folder the shell is in now: after a `cd` into a nested repository they would land in a second place, apart from the chain. Step 1 hands that folder to gather with `--root`.

## Cost Model — why the steps below are shaped this way

Every tool turn of this skill re-reads the WHOLE conversation, and every line of the file is paid again by the next session that reads it.

- **Budget: 3 tool turns to the written, indexed handoff** — gather, Write, index — plus one for the commit. Batch independent calls into ONE turn (when a commit follows, its message file is written in the same turn as the handoff). The file is written once: no Read-back, no Edit passes (the one exception is recording a commit that did not go through, Step 5).
- **Best moment: well before the context limit** (around 50% of the context, where the handoff mod asks by default, or earlier), not at the limit — same steps, a smaller conversation to re-read.
- **Length follows the session, ceiling 250 lines:** light session (one task, few approaches) ~40–100; heavy session (many approaches, measurements, decisions) 150–250. Never pad. Length is paid three times: writing, every later turn, the next session's start.

## Step 1: Gather — ONE Bash call

```bash
python3 -I "<base>/scripts/gather.py" [chain_tag]
```

**Auto mode:** add `--handoff-dir "<folder of the target path>"` to this same call — the target path without its file name, in double quotes. Without it, gather looks at the folder the shell is in now, which may belong to a different repository than the one the mod chose. With it, everything gather prints (`ROOT`, branch, commits, `HANDOFF_DIR`, the chain) is about that folder and the repository that contains it, and `HANDOFF_DIR` is exactly that folder (a missing one is still created by the Write).

**Manual mode:** add `--root "<session root>"` to this same call, in double quotes. The session root is the folder after `SESSION_ROOT:` — the handoff mod adds that line at the very end of this skill's text. Without that line, take the primary working directory from your environment (the folder the session started in, not the one a later `cd` moved the shell to). With it, gather looks at that folder and the repository that contains it, whatever folder the shell is in, so a manual handoff lands where an auto handoff of this session would. Never both options in one call.

Pass `chain_tag` when the session began with a pasted `Прочитай … (seq N, {tag}) …` prompt (the one Step 6 prints), or when you suspect a continuation. Prints (the git parts only inside a repository, the handoff parts only when the handoff folder exists): `ROOT`, branch, latest `v*` tag, recent commits, dirty files, `HANDOFF_DIR` (with "does not exist yet" when the folder has to be created), newest handoffs (chain + status), INDEX entry count, `FRESH_STANDALONE_TAG`, and — with a tag — that chain's handoffs by seq plus the newest one's "Where We're Going".

`NOT_GIT: yes` → **do not ask**, in either mode: write into the printed `HANDOFF_DIR`, skip the commit (Step 5), and say so in the report. If a `GIT_ERROR: <line>` line comes before it, git itself failed (a damaged repository, dubious ownership, …): put that line in the report word for word. Still write the handoff.

**Chain tag and parent** (first that applies):
1. Session began with a pasted `(seq N, {tag})` prompt → that tag; parent = that file; seq = N+1. The parent is already in your context — do NOT re-read it.
2. A version tag or feature branch — ONLY if this session's work is part of that version line / branch. Can't point to anything this session did toward it → skip to 3.
3. `FRESH_STANDALONE_TAG` from the gather output; seq 1; parent none.

Same tag found, but continuation unclear → new chain (seq 1) and list the sibling under Related Handoffs. In doubt → ask: "Is this a continuation of `{file}`? (default: new chain)" — in auto mode take the default without asking. For a continuation whose parent is NOT in context, the gather excerpt of its "Where We're Going" is enough for "Since Last Handoff" — don't read the full parent.

Project instructions and memory (`CLAUDE.md` and the like) are normally already in context — don't re-read them.

## Step 2: Mine the conversation — no tools

Long session → walk it in 3–4 chronological chunks (early / mid / late); the middle is where details get lost. Collect:
- goal; work done (files, functions, real numbers); **every approach tried, including failed ones + why**
- decisions + rejected alternatives; measurements (raw numbers); data file paths; gotchas
- the user's corrections, preferences, frustrations (their words); open questions; next steps

For each item: **does it already live in a durable artifact** (commit message, diff, spec, plan, changelog, data file, memory note)? Yes → one line with its absolute path. No → write it out. This is the main size lever.

Write what the conversation contains. Don't open files to enrich the handoff — detail the session didn't produce is the next session's job.

## Step 3: Write the file — ONE turn

- **Where:** manual mode — `HANDOFF_DIR` from gather (a missing folder is created by the Write; if it refuses, create the folder and retry). Auto mode — exactly the path you were given.
- **Name** (manual mode): `HANDOFF_{chain_tag}_{slug}_{YYYY-MM-DD}.md`, slug = 2–4 kebab words, collision → `_2`. In auto mode the name is given; the slug is only for the commit subject.
- **Date** from the harness context (system reminder), never from `date`. None in context → manual mode: ask the user; auto mode: take it from the file name `HANDOFF_auto_YYYY-MM-DD-HHMMSS.md`, and if the name does not fit that, write `unknown`.
- **All paths absolute** (`/Users/.../file.md`, `C:\...\file.md`) — the next session may start in a different directory. **Mask secrets** as `***`.
- **Second Write, same turn:** the commit-message file (Step 5). Skip it when there is nothing to commit (`NOT_GIT: yes`).

**The file is exactly these sections, in this order — ceiling 250 lines (see Cost Model for light vs heavy):**

```markdown
# {one-line summary}

**Date:** {YYYY-MM-DD}
**Status:** {COMPLETED | IN PROGRESS | BLOCKED}
**Chain:** `{chain_tag}` seq `{N}`
**Parent:** `{parent_filename}` | `none — first in chain`
**Prior chain:** `{file1}` > … > this | `none — first in chain`

## Since Last Handoff          ← only if seq > 1: parent's plan vs what happened, 3–5 bullets
## Related Handoffs            ← only if a sibling shares the tag: `{file}` — topic, separate stream
## The Goal                    ← 2–4 sentences: objective, why it matters, end state
## Where We Are                ← 8–15 bullets: file + function names, real numbers, what works / doesn't
## What We Tried               ← EVERY approach, chronological: hypothesis → result (numbers) → why
## Key Decisions               ← each non-obvious decision + WHY + the rejected alternative
## Evidence & Data             ← numbers that live nowhere else (tables ok); everything else = a path
## Files Changed               ← one line per file: absolute path — what and why (renamed and deleted files too)
## User Feedback & Preferences ← corrections, preferences, frustrations — in the user's words
## Where We're Going           ← ordered next steps, 3–7
## Risks & Open Questions      ← or "None"
## Suggested Skills            ← `skill-name` — why the next session needs it; or "None"
## Quick Start
- **Must-read (≤3):** {absolute paths — only files the next step cannot start without}
- **Verify first:** {command or check}
- **Next action:** {the single most important thing}

## Session Closed
**Closed at:** {YYYY-MM-DD}
**Commit:** `git log --grep "Handoff: {handoff_filename}"` (the block is committed together with the work, so it can't hold its own hash)
```

The `## Session Closed` block is written with the file, not appended later — that saves a turn. With `NOT_GIT: yes` its second line is `**Commit:** none — not committed (no usable git repository here)`.

**Over 250 lines → cut in this order:** Evidence tables that already exist in a file (→ path), then Files Changed detail, then Where We Are detail.
**Never cut:** What We Tried (failed approaches), rejected alternatives, measurements that live nowhere else, User Feedback — the most expensive things to rediscover.
**Under ~100 lines after a heavy session** → you summarized instead of extracting; add specifics (numbers, paths, the user's exact words) before writing.

**Check BEFORE the Write** (no re-read after): Where We Are names files and functions; What We Tried has one entry per approach; numbers, not adjectives ("28.6", not "high"); at least one rejected alternative; Quick Start has a concrete action; no secrets; the parent file appears in the gather output; the `**Chain:**` line has the template's exact form; auto mode: the path is exactly the one you were given.

## Step 4: Index + count — ONE Bash call

```bash
python3 -I "<base>/scripts/index.py" "{absolute handoff path}" {chain_tag} {N} {YYYY-MM-DD} "{STATUS}" "{topic}" "{next action}"
```

It appends `- [{tag} seq {N} — {topic}]({filename}) — {date}; {status}; next: {next}` to `INDEX.md` next to the handoff (creates the file if missing), shortens TOPIC and NEXT so the line stays within 200 characters (a very long tag or file name can still push it over), and prints the handoff's line count (`HANDOFF_LINES`). Never Read INDEX.md; never build the line by hand (unless Python is missing). Keep `$`, backticks, `"` and `\` out of TOPIC and NEXT — the shell may rewrite them before the script sees them.

Handoff pointers go to `INDEX.md` only — not into files that load into every session; the paste prompt already carries the path.

## Step 5: Commit — silently, no question

Skip when gather printed `NOT_GIT: yes`: nothing to commit, and the report says so.

The message file (written in Step 3's turn) is named `handoff-commit-msg-{slug}.txt` and goes outside the repository folder — into the session's scratchpad folder if there is one, otherwise the system temp folder — so it does not show up as a change. Keep that name pattern: the skill's permission rules (`allowed-tools`) are written for it. Its content:

```
session: {slug} [{chain_tag}]

{one-line summary of what this session accomplished}

Handoff: {handoff_filename}
Chain: {chain_tag} seq {N}

{attribution trailer from the system reminder, or the project CLAUDE.md if it specifies one; leave it out if neither does}
```

ONE Bash call:

```bash
python3 -I "<base>/scripts/commit.py" "{absolute handoff path}" --message-file "{message file}" --files {path1} {path2} …
```

`--files` lists **every file this session created, changed or deleted** — repo-relative, taken from your own tool calls, not from `git status` (that would sweep in work that is not this session's). Quote paths with spaces. For a rename pass BOTH the old and the new path. Never pass `.`, and never a folder unless this session created that folder (a folder stands for everything in it). The handoff and `INDEX.md` go in by themselves; if the session touched no other file, leave out `--files`.

The script commits only the handoff, `INDEX.md` and the paths it was given, and skips names that look like secrets (the handoff and `INDEX.md` excepted). It prints one line per outcome:
- `COMMITTED: <hash>`
- `COMMIT_SKIPPED: not a git repository`
- `COMMIT_FAILED: <reason>` — nothing was committed (a refused commit, a merge or rebase in progress, nothing to commit, …)
- `SKIPPED_SECRET: <path>` — not committed: the name looks like a secret
- `SKIPPED_IGNORED:`, `SKIPPED_MISSING:` — a path you passed that git ignores / that does not exist
- `SKIPPED_UNRELATED: <path>` — left uncommitted: changed in the working tree but not on your list, or a path you passed that is outside the repository or is `.`

A failed commit never stops the handoff. On `COMMIT_FAILED`, use the Edit tool on the handoff: replace its `**Commit:**` line with `**Commit failed:** <reason>`. On `COMMIT_SKIPPED`: `**Commit:** none — <reason>`. If the script exits with an error and prints no `COMMIT_` line (a usage error, for example), treat that as `COMMIT_FAILED` with the last line it printed as the reason.

## Step 6: Report, then finish by mode

Report: path + line count; chain (tag, seq, new / continuation); anything you had to ask or guess; the Next Action. Then the commit result:
- the `COMMITTED:` / `COMMIT_SKIPPED:` / `COMMIT_FAILED:` line as printed, or — with `NOT_GIT: yes` — that nothing was committed and why (plus the `GIT_ERROR:` line, word for word, if gather printed one);
- every `SKIPPED_SECRET:` line as printed, and that those files stay uncommitted;
- `SKIPPED_IGNORED:` and `SKIPPED_MISSING:` lines as printed; for `SKIPPED_UNRELATED:` only how many, plus any file you expected to be committed.

**Auto mode:** once the file is written, the last line is `HANDOFF_DONE: <path>` and nothing follows it.

**Manual mode:** print the paste prompt, then the tip.

### Paste prompt (manual mode)

Print "Paste this into your next session:" and the block below, in a code block so it copies in one go. Fill in `{absolute path}` (the handoff's absolute path), `{N}` (its seq) and `{chain_tag}`; everything else is copied character for character. `(seq {N}, {chain_tag})` is what Step 1 looks for in the next session — keep its form.

```text
Прочитай `{absolute path}` (seq {N}, {chain_tag}) и продолжи работу с раздела «Where We're Going».

Прежде чем начинать:
1. Перескажи в 5–8 строках: цель, текущее состояние, что пробовали и что не вышло
2. Прочитай ТОЛЬКО файлы из «Must-read» в Quick Start
3. Скажи, что проверишь первым и каким будет первый шаг
Потом жди моего «поехали».
```

Then the tip, in the user's language and with both key combinations: "Open a new session (terminal: run `claude` in this folder; app: ⌘N / Ctrl+N) and paste it."

## Archiving finished chains

When a work stream is done: find its files (the `**Chain:**` line names the tag; on macOS/Linux `grep -l 'Chain:.*{chain_tag}' {HANDOFF_DIR}/HANDOFF_*.md`), move them to `{HANDOFF_DIR}/archive/` (don't delete — old decisions stay useful).

## If Python is missing

Applies only when Python itself cannot start (`command not found`, `is not recognized`; on Windows both `py -3` and `python` fail). A script that started and printed its own error is not this case: read the error. Do the same work with plain git:
- **Step 1:** `git rev-parse --show-toplevel` (root; it fails outside a repository → use the current folder and treat it as `NOT_GIT`), `git branch --show-current`, `git status -s`, `git log --oneline -15`. `HANDOFF_DIR` is the first existing folder of `docs/superpowers/handoffs`, `plans/handoffs`, `docs/handoffs`, `.claude/handoffs` under the root; none exists → `docs/superpowers/handoffs` if `docs/superpowers` exists, otherwise `docs/handoffs`; outside git → `docs/handoffs` in the current folder. For a new chain make the tag `standalone-` plus 8 random hex digits. To find a chain parent, read the `**Chain:**` line of the newest `HANDOFF_*.md` files. Auto mode: `HANDOFF_DIR` is the folder of the target path, and every git command of this step is run as `git -C "<that folder>"` (a folder that does not exist yet: its nearest existing parent). Manual mode: every git command of this step is run as `git -C "<session root>"`, and outside git `HANDOFF_DIR` is `docs/handoffs` in the session root.
- **Step 4:** append one line to `INDEX.md` next to the handoff by hand, in the Step 4 format, at most 200 characters in total — shorten TOPIC and NEXT yourself (if `INDEX.md` is missing, start it with `# Handoff Index` and a blank line).
- **Step 5:** `git add` only the handoff, `INDEX.md` and this session's files (the same rules as `--files`; never `.`, `-A` or a whole folder), then `git commit -F "{message file}" -- {the same paths}`. Never add a file that matches the secret patterns of `scripts/commit.py`:
  - file names: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*credentials*`, `*secret*`, `*.keystore`, `*.env`, `id_ecdsa*`, `id_dsa*`
  - folder names (everything below such a folder too): `.env*`, `*secret*`, `*credentials*`

  Report what you skipped as a secret, `SKIPPED_SECRET:`-style, one line per file.
