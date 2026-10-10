#!/usr/bin/env python3
"""Handoff state gatherer: everything Step 1 of the handoff skill needs in ONE call.

Usage: python3 -I gather.py [chain_tag]        (Windows: py -3 -I gather.py [chain_tag])

Cross-platform port of the original gather.sh: written for Python 3.8+, standard
library only, git is the only external program. Prints `KEY: value` lines and
`--- section` blocks, in this order:
  - ROOT; BRANCH, LATEST_V_TAG and the sections recent commits / uncommitted / diff
    stat only inside a git repository; NOT_GIT otherwise (the current folder is then the
    root), and before it GIT_ERROR when git started but failed for a reason other than
    "not a git repository" (a damaged .git, dubious ownership, ...);
  - HANDOFF_DIR and FRESH_STANDALONE_TAG, always;
  - only when the handoff folder exists: the newest handoffs section and the INDEX line;
  - only when the handoff folder exists AND chain_tag is given: the chain candidates
    section, followed by the newest candidate's `Where We're Going` lines.

Handoff folder (pick_handoff_dir):
  - inside a git repository: the first existing of docs/superpowers/handoffs,
    plans/handoffs, docs/handoffs, .claude/handoffs (relative to the repository root);
    when none exists: docs/superpowers/handoffs if docs/superpowers exists, else
    docs/handoffs;
  - outside git: <current folder>/docs/handoffs.
  A NEW folder is never under .claude/: Claude Code treats that folder as sensitive (a
  write there was refused under acceptEdits in a live run), which would stall an unattended
  handoff. Inside a git repository an already existing .claude/handoffs is still found
  (last in the list), so older chains keep working; outside git it is not looked for.
"""
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

HANDOFF_DIR_CANDIDATES = ('docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs',
                          '.claude/handoffs')


def pick_handoff_dir(root, is_git):
    """Folder where handoffs of `root` live (it may not exist yet)."""
    if not is_git:
        return root / 'docs' / 'handoffs'
    for rel in HANDOFF_DIR_CANDIDATES:
        candidate = root.joinpath(*rel.split('/'))
        if candidate.is_dir():
            return candidate
    if (root / 'docs' / 'superpowers').is_dir():
        return root / 'docs' / 'superpowers' / 'handoffs'
    return root / 'docs' / 'handoffs'


def find_git_root():
    """Ask git for the repository root of the current folder. Returns (kind, detail):
      ('ok', Path)         inside a repository, detail is its root;
      ('not_repo', None)   git ran and says this is not a repository;
      ('missing', None)    the git program was not found (not installed or not on PATH);
      ('error', message)   git failed for any other reason; message is the first line of
                           its stderr (or the OS error text when git could not be started).
    LC_ALL=C keeps git's messages in English so the "not a git repository" check below
    does not depend on the user's language."""
    try:
        r = subprocess.run(['git', 'rev-parse', '--show-toplevel'], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace',
                           env=dict(os.environ, LC_ALL='C'))
    except FileNotFoundError:
        return 'missing', None
    except OSError as e:
        return 'error', str(e)
    if r.returncode == 0:
        out = r.stdout.rstrip('\r\n')
        return ('ok', Path(out)) if out else ('not_repo', None)
    if 'not a git repository' in r.stderr.lower():
        return 'not_repo', None
    first = next((line for line in r.stderr.splitlines() if line.strip()), '')
    return 'error', first or f'git exited with code {r.returncode}'


def git(root, *args, quiet=False):
    """stdout of `git -C root args` ('' on failure). git's own error text goes to
    stderr unless quiet. core.quotepath=off keeps non-ASCII file names readable."""
    try:
        r = subprocess.run(['git', '-C', str(root), '-c', 'core.quotepath=off', *args],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL if quiet else None,
                           text=True, encoding='utf-8', errors='replace')
    except OSError:
        return ''
    return r.stdout if r.returncode == 0 else ''


def read_lines(path):
    """File lines without line terminators; an unreadable file warns on stderr and gives []."""
    try:
        return path.read_text(encoding='utf-8', errors='replace').split('\n')
    except OSError as e:
        print(f'WARN: cannot read {path.name}: {e}', file=sys.stderr)
        return []


def field(lines, key):
    """Text after the first line that starts with `key` (leading spaces stripped), else ''."""
    for line in lines:
        if line.startswith(key):
            return line[len(key):].lstrip(' ')
    return ''


def names_chain(chain, tag):
    """True if the text of a `**Chain:**` header contains `tag` as a whole token: the
    characters right before and after it are not letters, digits, `_`, `.` or `-`.
    The tag is plain text, not a pattern. So tag `t1` does not match `t10` or `t1-b`,
    and tag `v1` does not match `v1.1`; tag `v1.2` matches `v1.2` but not `v1x2`."""
    return re.search(r'(?<![\w.-])' + re.escape(tag) + r'(?![\w.-])', chain) is not None


def where_going(lines, limit=15):
    """First `limit` non-blank lines of the `## Where We're Going` section(s); a section
    ends at the next line that starts with `## `."""
    out = []
    inside = False
    for line in lines:
        if re.match(r'## Where We.re Going', line):
            inside = True
            continue
        if line.startswith('## '):
            inside = False
        if inside and line.strip():
            out.append(line)
    return out[:limit]


def print_git_state(root):
    branch = git(root, 'branch', '--show-current').strip()
    print(f'BRANCH: {branch}')
    tags = [t for t in git(root, 'tag', '--sort=-creatordate', quiet=True).splitlines()
            if re.match(r'v[0-9]', t)]
    print(f'LATEST_V_TAG: {tags[0] if tags else ""}')
    print('--- recent commits')
    print(git(root, 'log', '--oneline', '-15'), end='')
    print('--- uncommitted (first 30)')
    for line in git(root, 'status', '-s').splitlines()[:30]:
        print(line)
    print('--- diff stat')
    stat = git(root, 'diff', '--stat').splitlines()
    if stat:
        print(stat[-1])


def print_handoffs(d):
    print('--- newest handoffs (max 5): file | chain | status')
    files = [f for f in d.glob('HANDOFF_*.md') if f.is_file()]
    files.sort(key=lambda f: (-f.stat().st_mtime_ns, f.name))
    for f in files[:5]:
        lines = read_lines(f)
        print(f"{f.name} | {field(lines, '**Chain:**')} | {field(lines, '**Status:**')}")
    index = d / 'INDEX.md'
    if index.is_file():
        entries = sum(1 for line in read_lines(index) if line.startswith('- ['))
        print(f'INDEX: {index} ({entries} entries)')
    else:
        print('INDEX: none')


def print_chain(d, tag):
    print(f"--- chain candidates for '{tag}', by seq ascending")
    # A candidate names the tag in its first `**Chain:**` header line (see names_chain).
    # Auto-handoffs (`**Auto:** true`) are full chain members, not excluded.
    # Sort by seq, NOT mtime: old handoffs get edited later and would look "newest".
    found = []
    for f in sorted(d.glob('HANDOFF_*.md')):
        if not f.is_file():
            continue
        lines = read_lines(f)
        chain = field(lines, '**Chain:**')
        if not names_chain(chain, tag):
            continue
        m = re.search(r'seq `?([0-9]+)', chain)
        found.append((int(m.group(1)) if m else 0, f.name, f, chain))
    if not found:
        print('none')
        return
    found.sort(key=lambda c: (c[0], c[1]))
    for _, name, _, chain in found:
        print(f'{name} | {chain}')
    _, name, last, _ = found[-1]
    print(f"--- newest candidate's 'Where We're Going' (max 15 lines): {name}")
    for line in where_going(read_lines(last)):
        print(line)


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    tag = argv[1] if len(argv) > 1 else ''

    kind, detail = find_git_root()
    is_git = kind == 'ok'
    if is_git:
        root = detail
        print(f'ROOT: {root}')
        print_git_state(root)
    else:
        root = Path.cwd()
        print(f'ROOT: {root}')
        if kind == 'error':
            print(f'GIT_ERROR: {detail}')
            print('NOT_GIT: yes — git failed (see GIT_ERROR), using the current folder')
        elif kind == 'missing':
            print('NOT_GIT: yes — git is not installed')
        else:
            print('NOT_GIT: yes — no git repository found, using the current folder')

    d = pick_handoff_dir(root, is_git)
    if d.is_dir():
        print(f'HANDOFF_DIR: {d}')
    else:
        print(f'HANDOFF_DIR: {d} (does not exist yet — create it)')

    print(f'FRESH_STANDALONE_TAG: standalone-{secrets.token_hex(4)}')

    if d.is_dir():
        print_handoffs(d)
        if tag:
            print_chain(d, tag)


if __name__ == '__main__':
    main(sys.argv)
