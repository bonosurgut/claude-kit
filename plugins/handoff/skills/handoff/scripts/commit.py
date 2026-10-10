#!/usr/bin/env python3
"""Silent handoff commit: the handoff, INDEX.md and the session's own files, never secrets.

Usage: python3 -I commit.py HANDOFF_PATH --message-file MSG [--files F ...]
       (Windows: py -3 -I commit.py ...)

Written for Python 3.8+, standard library only; git is the only external program.
The message comes from MSG (read as UTF-8); a path in --files is relative to the repository
root unless it is absolute. A folder in --files stands for the files in it, and every one
of them goes through the same checks as a file named directly.

Exit code: 0 after any outcome git can produce, a refused commit included (a failed commit
must not stop the handoff); wrong arguments exit 2. Each outcome is a line of its own.
Unless a COMMIT_FAILED stops the run early, each path asked for (the handoff and INDEX.md
too) is either handed to git or named in exactly one SKIPPED_ line; a path given twice
counts once, and a file handed to git that has no changes simply adds nothing to the
commit. The lines:
  COMMITTED: <short hash>
  COMMIT_SKIPPED: not a git repository
  COMMIT_FAILED: <reason>           nothing was committed; files already staged by this
                                    script may stay staged
  SKIPPED_SECRET: <path>            the file name matches SECRET, or the name of any folder
                                    above it matches SECRET_DIR (both case-insensitive,
                                    both checked on the path relative to the repository
                                    root). The handoff and its INDEX.md are exempt from this
                                    check: a secret-looking name on the way to them does not
                                    stop them (an ignore rule still can).
  SKIPPED_IGNORED: <path>           matched by an ignore rule and not tracked
  SKIPPED_MISSING: <path>           not on disk, not in the index, not in HEAD (for a
                                    folder: nothing in it that git would add or remove)
  SKIPPED_UNRELATED: <path>         changed in the working tree, but not asked for; also
                                    - a path asked for that is outside the repository
                                      (printed as an absolute path);
                                    - the old name of a staged rename whose new name was
                                      asked for and the old one was not (when the new name
                                      is committed, it goes in as an addition only and the
                                      deletion of the old name stays staged);
                                    - `. (repository root is never expanded)`: the repository
                                      root (`.`, an empty name, `./`) was asked for. It is
                                      never expanded; the other paths are handled as usual.

An asked-for path that passes the checks above and is gone from the disk and from the index
but still in HEAD (git rm, git mv) is a deletion: it is not given to `git add` (git refuses a
name it no longer knows) and it is committed. Only the asked-for paths are committed: files staged earlier for something else
are left staged and are not part of this commit (git commit -- <paths>). While a merge,
cherry-pick, revert or rebase is under way, or the index holds unmerged paths, the index
is not touched at all: COMMIT_FAILED and nothing else is printed.
"""
import argparse
import fnmatch
import os
import subprocess
import sys
from pathlib import Path

# File names (spec F-12: `.env*` is wider than `.env` + `.env.*` on purpose: .envrc often holds secrets;
# `*.env` catches prod.env, which `.env*` misses; id_ecdsa* and id_dsa* are two more of OpenSSH's default key names).
SECRET = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*',
          '*credentials*', '*secret*', '*.keystore', '*.env', 'id_ecdsa*', 'id_dsa*']
# Folder names: everything below a folder that matches is treated as a secret too.
SECRET_DIR = ['.env*', '*secret*', '*credentials*']
# Entries of the git folder that exist only while one of these operations is unfinished.
IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
IN_PROGRESS_MSG = 'merge or rebase in progress — commit skipped, index untouched'
ROOT_MSG = '. (repository root is never expanded)'


class GitMissing(Exception):
    pass


class GitFailed(Exception):
    pass


def is_secret(path: str) -> bool:
    """True when the file name matches SECRET or the name of any folder above it matches
    SECRET_DIR, case-insensitively. Meant for a path relative to the repository root: the
    folders of an absolute path would be counted too."""
    parts = Path(path).parts
    if not parts:
        return False
    if any(fnmatch.fnmatchcase(parts[-1].lower(), p) for p in SECRET):
        return True
    return any(fnmatch.fnmatchcase(d.lower(), p) for d in parts[:-1] for p in SECRET_DIR)


def git(root, *args, input=None, env=None, literal=True):
    """`git -C root args`. literal: a name like `a[1].txt` or `x*.py` is a file name, not a
    pattern (git check-ignore refuses --literal-pathspecs, and takes names literally anyway).
    core.quotepath=off keeps non-ASCII names readable."""
    flags = ['--literal-pathspecs'] if literal else []
    try:
        return subprocess.run(['git', *flags, '-C', str(root), '-c', 'core.quotepath=off', *args],
                              input=input, capture_output=True, text=True, encoding='utf-8',
                              errors='replace', env=env)
    except FileNotFoundError:
        raise GitMissing()


def last_lines(r, default):
    """Up to 3 last lines of git's stderr (stdout when stderr is empty), on one line."""
    why = (r.stderr.strip() or r.stdout.strip() or default).splitlines()
    return ' | '.join(why[-3:])


def status_paths(root):
    """(path, old name) for every changed FILE git status lists (--untracked-files=all: an
    untracked folder is not folded into one `dir/` entry). The old name is set for a rename
    only, otherwise None. The result is None when git status fails."""
    r = git(root, 'status', '--porcelain', '-z', '--untracked-files=all')
    if r.returncode != 0:
        return None
    parts = r.stdout.split('\0')
    paths, i = [], 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        old = None
        if entry[0] in 'RC' or entry[1] in 'RC':
            # a rename/copy entry is followed by a bare entry holding the old name
            if i < len(parts) and 'R' in entry[:2]:
                old = parts[i]
            i += 1
        paths.append((entry[3:], old))
    return paths


def in_progress(root):
    """True when a merge, cherry-pick, revert or rebase is unfinished, or the index holds
    unmerged paths (a stash pop with conflicts leaves those without any marker)."""
    r = git(root, 'rev-parse', '--git-dir')
    if r.returncode != 0:
        raise GitFailed(f'git rev-parse --git-dir: {last_lines(r, "failed")}')
    git_dir = root / r.stdout.rstrip('\r\n')  # absolute when git says so, else relative to root
    if any((git_dir / marker).exists() for marker in IN_PROGRESS):
        return True
    u = git(root, 'ls-files', '-u', '-z')
    if u.returncode != 0:
        raise GitFailed(f'git ls-files -u: {last_lines(u, "failed")}')
    return bool(u.stdout)


def locate(p):
    """Absolute path with the folders resolved (macOS /var -> /private/var, as git reports
    the repository root) but the last name left alone: a symlink is committed as a symlink."""
    p = Path(os.path.abspath(str(p)))
    return p.parent.resolve() / p.name


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('handoff')
    ap.add_argument('--message-file', required=True)
    ap.add_argument('--files', nargs='*', default=[])
    a = ap.parse_args()
    try:
        commit(a)
    except GitMissing:
        print('COMMIT_FAILED: git is not installed')
    except GitFailed as e:
        print(f'COMMIT_FAILED: {e}')
    except OSError as e:
        print(f'COMMIT_FAILED: {e}')


def commit(a):
    folder = Path(a.handoff).parent
    if not folder.is_dir():
        print(f'COMMIT_FAILED: handoff folder not found: {folder}')
        return
    # LC_ALL=C keeps git's messages in English so the "not a git repository" check below
    # does not depend on the user's language.
    top = git(folder, 'rev-parse', '--show-toplevel', env=dict(os.environ, LC_ALL='C'))
    if top.returncode != 0:
        if 'not a git repository' in top.stderr.lower():
            print('COMMIT_SKIPPED: not a git repository')
        else:
            print(f'COMMIT_FAILED: {last_lines(top, "git rev-parse failed")}')
        return
    top_dir = top.stdout.rstrip('\r\n')
    if not top_dir:
        print('COMMIT_FAILED: git did not report the repository root')
        return
    root = Path(top_dir)
    if in_progress(root):
        print(f'COMMIT_FAILED: {IN_PROGRESS_MSG}')
        return
    head = git(root, 'rev-parse', '--verify', '-q', 'HEAD')
    if head.returncode not in (0, 1):  # 1 = no commit yet
        raise GitFailed(f'git rev-parse HEAD: {last_lines(head, "failed")}')
    has_head = head.returncode == 0

    handoff = locate(a.handoff)
    index = handoff.parent / 'INDEX.md'
    wanted = [handoff, index] + [locate(root / f) for f in a.files]
    exempt = set()  # the handoff and its INDEX.md: committed whatever the path to them is called
    for f in (handoff, index):
        try:
            exempt.add(f.relative_to(root).as_posix())
        except ValueError:
            pass

    picked = []     # root-relative paths for `git add` and for the commit
    deletions = []  # gone from the disk and the index, still in HEAD: in the commit, not in `git add`
    handled = set()  # every path that is picked or already named in a SKIPPED_ line

    def ls(*args):
        r = git(root, *args)
        if r.returncode != 0:
            raise GitFailed(f'git {args[0]}: {last_lines(r, "failed")}')
        return [m for m in r.stdout.split('\0') if m]

    def consider(rel):
        """One path: into `picked`, or exactly one SKIPPED_ line."""
        if rel in handled:
            return
        handled.add(rel)
        p = root.joinpath(*rel.split('/'))
        if rel not in exempt and is_secret(rel):
            print(f'SKIPPED_SECRET: {rel}')
            return
        ci = git(root, 'check-ignore', '-q', '--', rel, literal=False)
        if ci.returncode == 0:
            print(f'SKIPPED_IGNORED: {rel}')
            return
        if ci.returncode != 1:  # 1 = not ignored; anything else is git failing, not an answer
            raise GitFailed(f'git check-ignore: {last_lines(ci, "failed")}')
        if not os.path.lexists(p) or (p.is_dir() and not p.is_symlink()):
            # A folder, or a path that is gone from the disk: what git has under that name,
            # in the index (and untracked, for a folder) and in HEAD.
            in_index = ls('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', rel)
            in_head = ls('ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', rel) if has_head else []
            if in_index == [rel]:
                picked.append(rel)  # a tracked file deleted from the disk: the deletion is committed
            elif not in_index and in_head == [rel]:
                deletions.append(rel)  # staged deletion (git rm, git mv): nothing left to `git add`
            else:
                members = in_index + [m for m in in_head if m not in in_index]
                if not members:
                    print(f'SKIPPED_MISSING: {rel}')
                for m in members:
                    consider(m)
            return
        picked.append(rel)

    for p in wanted:
        try:
            rel = p.relative_to(root).as_posix()
        except ValueError:
            if str(p) not in handled:
                handled.add(str(p))
                print(f'SKIPPED_UNRELATED: {p}')
            continue
        if rel == '.':
            if '.' not in handled:
                handled.add('.')
                print(f'SKIPPED_UNRELATED: {ROOT_MSG}')
            continue
        consider(rel)

    changed = status_paths(root)
    if changed is None:
        print('COMMIT_FAILED: git status failed')
        return
    for rel, old in changed:
        if rel not in handled:
            print(f'SKIPPED_UNRELATED: {rel}')
        elif old is not None and old not in handled:
            handled.add(old)  # the new name is going in, the deletion of the old one is not
            print(f'SKIPPED_UNRELATED: {old}')

    if not picked and not deletions:
        print('COMMIT_FAILED: nothing to commit')
        return
    try:
        msg = Path(a.message_file).read_text(encoding='utf-8')
    except (OSError, ValueError) as e:  # ValueError covers UnicodeDecodeError
        print(f'COMMIT_FAILED: cannot read message file: {e}')
        return
    if picked:
        add = git(root, 'add', '--', *picked)
        if add.returncode != 0:
            print(f'COMMIT_FAILED: {last_lines(add, "git add failed")}')
            return
    paths = picked + deletions
    if git(root, 'diff', '--cached', '--quiet', '--', *paths).returncode == 0:
        print('COMMIT_FAILED: nothing to commit')
        return
    c = git(root, 'commit', '-q', '-F', '-', '--', *paths, input=msg)
    if c.returncode != 0:
        print(f'COMMIT_FAILED: {last_lines(c, "git commit failed")}')
        return
    print(f'COMMITTED: {git(root, "rev-parse", "--short", "HEAD").stdout.strip()}')


if __name__ == '__main__':
    main()
