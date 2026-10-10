import os
import subprocess
from importlib import util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / 'skills/handoff/scripts/commit.py'
HANDOFF = '.claude/handoffs/HANDOFF_t_x_2026-10-08.md'
INDEX = '.claude/handoffs/INDEX.md'
# The script under test runs with the machine's own git configuration unless told otherwise;
# a global commit hook or signing setting would make these tests depend on the machine.
# (GIT_CONFIG_GLOBAL is honoured by git 2.32 and newer only.)
ISOLATED = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}


def git(repo, *a):
    return subprocess.run(['git', '-C', str(repo), *a], capture_output=True, text=True, encoding='utf-8',
                          env=dict(os.environ, **ISOLATED)).stdout


def committed(repo):
    """Sorted names of the files in HEAD's commit, straight from git (one name per line,
    so names with spaces survive)."""
    return sorted(git(repo, '-c', 'core.quotepath=off', 'show', '--name-only', '--format=', 'HEAD').splitlines())


def commit_count(repo):
    return int(git(repo, 'rev-list', '--count', 'HEAD'))


def skipped(out):
    return [l for l in out.splitlines() if l.startswith('SKIPPED_')]


def setup(repo):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    hp = h / 'HANDOFF_t_x_2026-10-08.md'; hp.write_text('# h\n', encoding='utf-8')
    (h / 'INDEX.md').write_text('# Handoff Index\n', encoding='utf-8')
    msg = repo.parent / 'msg.txt'; msg.write_text('session: x [t]\n', encoding='utf-8')
    return hp, msg


def go(run, hp, msg, *files, cwd, env=None):
    """commit.py HANDOFF --message-file MSG [--files ...] -> stdout."""
    args = ['commit.py', str(hp), '--message-file', str(msg)]
    if files:
        args += ['--files', *files]
    return run(*args, cwd=cwd, env=dict(ISOLATED, **(env or {})))


def load_commit_module():
    spec = util.spec_from_file_location('commit_mod', SCRIPT)
    m = util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


# --- tests from the task brief ----------------------------------------------------------------

def test_commits_session_files_only(repo, run):
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    (repo / 'other.txt').write_text('not mine', encoding='utf-8')
    out = go(run, hp, msg, 'a.txt', cwd=repo)
    short = git(repo, 'rev-parse', '--short', 'HEAD').strip()
    assert [l for l in out.splitlines() if l.startswith('COMMITTED:')] == [f'COMMITTED: {short}']
    assert 'SKIPPED_UNRELATED: other.txt' in out
    # The untracked .claude/ folder is listed file by file, so it is never one `.claude/` line,
    # and a.txt (asked for, committed) is not in any SKIPPED_ line: the only skipped path is other.txt.
    assert skipped(out) == ['SKIPPED_UNRELATED: other.txt']
    assert committed(repo) == sorted([INDEX, HANDOFF, 'a.txt'])
    assert commit_count(repo) == 2


def test_secrets_never_committed(repo, run):
    hp, msg = setup(repo)
    names = ['.env', '.env.local', 'prod.key', 'cert.pem', 'aws_credentials.json', 'my-secret.txt', 'id_rsa']
    for n in names:
        (repo / n).write_text('s', encoding='utf-8')
    out = go(run, hp, msg, *names, cwd=repo)
    assert out.count('SKIPPED_SECRET:') == 7
    # 7 secrets asked for -> exactly 7 SKIPPED_ lines, one per file: a secret is not also
    # reported as unrelated just because it is untracked.
    assert sorted(skipped(out)) == sorted(f'SKIPPED_SECRET: {n}' for n in names)
    assert committed(repo) == sorted([INDEX, HANDOFF])


def test_ssh_key_and_dot_env_names_are_secrets(repo, run):
    # The names added at the publish gate, through the real script: every one is printed as
    # SKIPPED_SECRET and stays out of the commit; the near misses are committed.
    hp, msg = setup(repo)
    secret_names = ['id_dsa', 'id_dsa.pub', 'id_ecdsa', 'prod.env', '.ENV']
    fine_names = ['environment.md', 'envelope.txt', 'my_dsa_notes.md']
    for n in secret_names + fine_names:
        (repo / n).write_text('x', encoding='utf-8')
    out = go(run, hp, msg, *secret_names, *fine_names, cwd=repo)
    assert len(secret_names) == 5 and len(fine_names) == 3  # 8 paths asked for, 5 + 3
    assert out.count('SKIPPED_SECRET:') == 5
    assert sorted(skipped(out)) == sorted(f'SKIPPED_SECRET: {n}' for n in secret_names)
    assert committed(repo) == sorted([INDEX, HANDOFF, *fine_names])


def test_not_a_secret():
    m = load_commit_module()
    assert [m.is_secret(x) for x in ['src/keyboard.ts', 'docs/secrets-policy-ru.md', 'README.md', 'config/.env.example']] == [False, True, False, True]


def test_ignored_handoff_reported(repo, run):
    (repo / '.gitignore').write_text('.claude/\n', encoding='utf-8')
    git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ignore')
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    out = go(run, hp, msg, 'a.txt', cwd=repo)
    assert 'SKIPPED_IGNORED: .claude/handoffs/HANDOFF_t_x_2026-10-08.md' in out
    assert 'COMMITTED:' in out
    assert sorted(skipped(out)) == sorted([f'SKIPPED_IGNORED: {HANDOFF}', f'SKIPPED_IGNORED: {INDEX}'])
    assert git(repo, 'show', '--name-only', '--format=', 'HEAD').split() == ['a.txt']


def test_no_git(tmp_path, run):
    hp = tmp_path / 'H.md'; hp.write_text('x', encoding='utf-8')
    msg = tmp_path / 'm.txt'; msg.write_text('m', encoding='utf-8')
    assert go(run, hp, msg, cwd=tmp_path).strip() == 'COMMIT_SKIPPED: not a git repository'


@pytest.mark.skipif(os.name == 'nt', reason='relies on POSIX execute permission bits')
def test_hook_rejects_commit(repo, run):
    hp, msg = setup(repo)
    hook = repo / '.git/hooks/pre-commit'; hook.write_text('#!/bin/sh\necho nope >&2\nexit 1\n'); hook.chmod(0o755)
    out = go(run, hp, msg, cwd=repo)
    assert 'COMMIT_FAILED:' in out and 'nope' in out
    assert [l for l in out.splitlines() if l.startswith('COMMIT')] == ['COMMIT_FAILED: nope']
    assert commit_count(repo) == 1  # the refusal is not turned into a commit


def test_commit_cyrillic_space(tmp_path, run, make_repo):
    r = make_repo(tmp_path / 'Мои проекты' / 'сайт')
    hp, msg = setup(r)
    (r / 'файл с пробелом.txt').write_text('x', encoding='utf-8')
    out = go(run, hp, msg, 'файл с пробелом.txt', cwd=r)
    assert 'COMMITTED:' in out
    assert 'файл с пробелом.txt' in git(r, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD')
    assert skipped(out) == []
    assert committed(r) == sorted([INDEX, HANDOFF, 'файл с пробелом.txt'])


# --- is_secret: the name is what counts ---------------------------------------------------------

def test_is_secret_boundaries():
    m = load_commit_module()
    cases = {
        # secret by file name, whatever the case or the folder
        '.env': True, '.ENV': True, 'a/b/.env.production': True, 'Server.PEM': True, 'k.p12': True,
        'k.pfx': True, 'app.keystore': True, 'id_ed25519': True, 'id_rsa.pub': True, 'ID_RSA': True,
        'gcp-Credentials.json': True, 'client_secret.json': True, 'tls.key': True,
        # everything F-12 writes as `.env*`: anything that starts with .env
        '.envrc': True, '.env-local': True, '.env_prod': True, '.environment': True, '.envrc.local': True,
        # added at the publish gate: `*.env`, `id_ecdsa*`, `id_dsa*` (the same name rules, any case, any folder)
        'prod.env': True, 'PROD.ENV': True, 'a/b/staging.Env': True, 'id_dsa': True, 'id_dsa.pub': True,
        'ID_DSA': True, 'id_ecdsa': True, 'id_ecdsa.pub': True, 'id_ecdsa_sk': True, 'Id_EcDsa': True,
        '.ssh/id_dsa': True, 'home/.ssh/id_ecdsa.pub': True,
        # near misses that are not
        'environment.md': False, 'envelope.txt': False, 'my_dsa_notes.md': False, 'ecdsa.md': False,
        'dsa_id': False, 'id_ecd.md': False, 'prod.env.d': False, 'env': False,
        'environment.ts': False, 'monkey.ts': False, 'turkey.md': False,
        'keyboard.ts': False, 'pem.md': False, 'idrsa': False, 'my.env.d': False,
        # a folder above the file counts: .env*, *secret*, *credentials* (case-insensitive)
        'secrets/notes.txt': True, 'secrets/db.yml': True, 'config/credentials/gcp.json': True,
        '.envs/.production/.django': True, 'Secrets/x.txt': True, 'a/b/my-secret-stuff/c/d.txt': True,
        '.env.d/x.txt': True, 'AWS_CREDENTIALS/x.txt': True,
        # folders that match nothing
        '.ssh/config': False, 'src/keys/readme.md': False, 'docs/security/policy.md': False,
        'my.env.d/x.txt': False, 'src/x': False,
        # the new file-name patterns are file names only, like `*.pem` and `id_rsa*` before them:
        # a folder called prod.env or id_dsa does not make what is inside a secret
        'prod.env/readme.md': False, 'id_dsa/readme.md': False, 'id_ecdsa/readme.md': False,
    }
    assert [m.is_secret(p) for p in cases] == list(cases.values())
    assert m.is_secret('') is False and m.is_secret('.') is False


# --- how the commit is built ----------------------------------------------------------------

def test_every_input_has_exactly_one_outcome(repo, run):
    # 9 paths in: handoff, INDEX, a.txt, keep.txt, .env, ghost.txt, build.log, then a.txt and
    # .env once more: 7 distinct paths, a repeat must not add a second line.
    (repo / '.gitignore').write_text('*.log\n', encoding='utf-8')
    (repo / 'keep.txt').write_text('v1\n', encoding='utf-8')
    git(repo, 'add', '.gitignore', 'keep.txt'); git(repo, 'commit', '-qm', 'more')
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    (repo / 'keep.txt').write_text('v2\n', encoding='utf-8')
    (repo / '.env').write_text('s', encoding='utf-8')
    (repo / 'build.log').write_text('log', encoding='utf-8')
    (repo / 'stray.txt').write_text('not asked for', encoding='utf-8')
    out = go(run, hp, msg, 'a.txt', 'keep.txt', '.env', 'ghost.txt', 'build.log', 'a.txt', '.env', cwd=repo)
    assert sorted(skipped(out)) == sorted([
        'SKIPPED_SECRET: .env', 'SKIPPED_MISSING: ghost.txt', 'SKIPPED_IGNORED: build.log',
        'SKIPPED_UNRELATED: stray.txt'])
    assert committed(repo) == sorted([INDEX, HANDOFF, 'a.txt', 'keep.txt'])
    # Of the 7 distinct paths asked for, 3 are skipped and 4 committed; none counted twice.
    asked = {HANDOFF, INDEX, 'a.txt', 'keep.txt', '.env', 'ghost.txt', 'build.log'}
    named_in_skips = {l.split(': ', 1)[1] for l in skipped(out)} & asked
    assert named_in_skips == {'.env', 'ghost.txt', 'build.log'}
    assert named_in_skips | set(committed(repo)) == asked
    assert named_in_skips & set(committed(repo)) == set()


def test_staged_files_of_something_else_stay_out_of_the_commit(repo, run):
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    (repo / 'staged_other.txt').write_text('staged by the user earlier', encoding='utf-8')
    (repo / '.env').write_text('s', encoding='utf-8')
    git(repo, 'add', 'staged_other.txt', '.env')
    out = go(run, hp, msg, 'a.txt', cwd=repo)
    assert sorted(skipped(out)) == ['SKIPPED_UNRELATED: .env', 'SKIPPED_UNRELATED: staged_other.txt']
    assert committed(repo) == sorted([INDEX, HANDOFF, 'a.txt'])
    # still staged, not lost and not committed
    assert sorted(git(repo, 'diff', '--cached', '--name-only').splitlines()) == ['.env', 'staged_other.txt']


def test_unrelated_untracked_files_listed_one_per_file(repo, run):
    hp, msg = setup(repo)
    (repo / 'other/deep').mkdir(parents=True)
    (repo / 'other/deep/x.txt').write_text('1', encoding='utf-8')
    (repo / 'other/y.txt').write_text('2', encoding='utf-8')
    out = go(run, hp, msg, cwd=repo)
    assert sorted(skipped(out)) == ['SKIPPED_UNRELATED: other/deep/x.txt', 'SKIPPED_UNRELATED: other/y.txt']
    assert committed(repo) == sorted([INDEX, HANDOFF])


def test_staged_rename_is_one_unrelated_entry(repo, run):
    (repo / 'old.txt').write_text('some content that git can match\n' * 5, encoding='utf-8')
    git(repo, 'add', 'old.txt'); git(repo, 'commit', '-qm', 'old')
    git(repo, 'mv', 'old.txt', 'new.txt')
    hp, msg = setup(repo)
    out = go(run, hp, msg, cwd=repo)
    assert skipped(out) == ['SKIPPED_UNRELATED: new.txt']
    assert committed(repo) == sorted([INDEX, HANDOFF])


def test_folder_in_files_is_expanded_and_secrets_inside_stay_out(repo, run):
    hp, msg = setup(repo)
    (repo / 'src/deep').mkdir(parents=True)
    for n in ['src/app.py', 'src/.env', 'src/deep/key.pem', 'src/deep/mod.py']:
        (repo / n).write_text('x', encoding='utf-8')
    out = go(run, hp, msg, 'src', cwd=repo)
    assert sorted(skipped(out)) == ['SKIPPED_SECRET: src/.env', 'SKIPPED_SECRET: src/deep/key.pem']
    assert committed(repo) == sorted([INDEX, HANDOFF, 'src/app.py', 'src/deep/mod.py'])


def test_folder_with_nothing_for_git_is_reported_missing(repo, run):
    (repo / '.gitignore').write_text('cache/\n', encoding='utf-8')
    git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ignore cache')
    hp, msg = setup(repo)
    (repo / 'empty').mkdir()
    (repo / 'cache').mkdir(); (repo / 'cache/blob.bin').write_text('x', encoding='utf-8')
    out = go(run, hp, msg, 'empty', 'cache', cwd=repo)
    assert sorted(skipped(out)) == ['SKIPPED_IGNORED: cache', 'SKIPPED_MISSING: empty']
    assert committed(repo) == sorted([INDEX, HANDOFF])


def test_unchanged_file_asked_for_adds_nothing_and_breaks_nothing(repo, run):
    hp, msg = setup(repo)  # a.txt is tracked and untouched
    out = go(run, hp, msg, 'a.txt', cwd=repo)
    assert skipped(out) == []
    assert 'COMMITTED:' in out
    assert committed(repo) == sorted([INDEX, HANDOFF])


def test_deleted_tracked_file_is_committed_as_a_deletion(repo, run):
    hp, msg = setup(repo)
    (repo / 'a.txt').unlink()
    out = go(run, hp, msg, 'a.txt', cwd=repo)
    assert skipped(out) == []
    assert sorted(git(repo, 'show', '--name-status', '--format=', 'HEAD').splitlines()) == \
        sorted([f'A\t{INDEX}', f'A\t{HANDOFF}', 'D\ta.txt'])


def test_file_names_with_glob_characters_are_literal(repo, run):
    hp, msg = setup(repo)
    (repo / 'a[1].txt').write_text('asked for', encoding='utf-8')
    (repo / 'a1.txt').write_text('a glob would match this one', encoding='utf-8')
    out = go(run, hp, msg, 'a[1].txt', cwd=repo)
    assert skipped(out) == ['SKIPPED_UNRELATED: a1.txt']
    assert committed(repo) == sorted([INDEX, HANDOFF, 'a[1].txt'])


def test_secret_named_handoff_is_still_committed(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    name = 'HANDOFF_t_secret-rotation_2026-10-08.md'
    hp = h / name; hp.write_text('# h\n', encoding='utf-8')
    msg = repo.parent / 'msg.txt'; msg.write_text('session: x [t]\n', encoding='utf-8')
    out = go(run, hp, msg, cwd=repo)
    assert 'SKIPPED_SECRET' not in out
    assert committed(repo) == sorted([f'.claude/handoffs/{name}'])


def test_relative_handoff_path_and_file_outside_the_repository(repo, run, tmp_path):
    hp, msg = setup(repo)
    outside = tmp_path.parent / 'outside_the_repo.txt'
    outside.write_text('x', encoding='utf-8')
    expected_line = f'SKIPPED_UNRELATED: {outside.resolve()}'
    try:
        out = go(run, HANDOFF, msg, str(outside), cwd=repo)
    finally:
        outside.unlink()
    assert skipped(out) == [expected_line]
    assert 'COMMITTED:' in out
    assert committed(repo) == sorted([INDEX, HANDOFF])


def test_running_twice_commits_once(repo, run):
    hp, msg = setup(repo)
    first = go(run, hp, msg, cwd=repo)
    assert 'COMMITTED:' in first
    second = go(run, hp, msg, cwd=repo)
    assert second.strip() == 'COMMIT_FAILED: nothing to commit'
    assert commit_count(repo) == 2  # init + the first run


def test_first_commit_of_a_new_repository(tmp_path, run):
    git(tmp_path, 'init', '-q')
    git(tmp_path, 'config', 'user.email', 'test@example.com'); git(tmp_path, 'config', 'user.name', 'Test')
    git(tmp_path, 'config', 'commit.gpgsign', 'false')
    hp, msg = setup(tmp_path)
    out = go(run, hp, msg, cwd=tmp_path)
    assert 'COMMITTED:' in out
    assert committed(tmp_path) == sorted([INDEX, HANDOFF])
    assert commit_count(tmp_path) == 1


def test_missing_path_in_a_repository_without_commits_is_reported_missing(tmp_path, run):
    # No HEAD to look a deleted file up in: that is "not in HEAD", not an error.
    git(tmp_path, 'init', '-q')
    git(tmp_path, 'config', 'user.email', 'test@example.com'); git(tmp_path, 'config', 'user.name', 'Test')
    git(tmp_path, 'config', 'commit.gpgsign', 'false')
    hp, msg = setup(tmp_path)
    out = go(run, hp, msg, 'ghost.txt', cwd=tmp_path)
    assert skipped(out) == ['SKIPPED_MISSING: ghost.txt']
    assert 'COMMITTED:' in out
    assert committed(tmp_path) == sorted([INDEX, HANDOFF])


def test_nothing_to_commit_when_every_path_is_skipped(repo, run):
    (repo / '.gitignore').write_text('.claude/\n', encoding='utf-8')
    git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ignore')
    hp, msg = setup(repo)
    out = go(run, hp, msg, cwd=repo)
    assert [l for l in out.splitlines() if not l.startswith('SKIPPED_')] == ['COMMIT_FAILED: nothing to commit']
    assert commit_count(repo) == 2


# --- failures stay one line and exit 0 ----------------------------------------------------------

def test_unreadable_message_file_fails_before_anything_is_staged(repo, run):
    hp, _ = setup(repo)
    out = go(run, hp, repo.parent / 'no-such-message.txt', cwd=repo)
    assert out.strip().startswith('COMMIT_FAILED: cannot read message file: ')
    assert len(out.strip().splitlines()) == 1
    assert git(repo, 'diff', '--cached', '--name-only') == ''
    assert commit_count(repo) == 1


def test_empty_message_is_refused_by_git_and_reported(repo, run):
    hp, _ = setup(repo)
    empty = repo.parent / 'empty.txt'; empty.write_text('', encoding='utf-8')
    out = go(run, hp, empty, cwd=repo)
    assert out.strip().startswith('COMMIT_FAILED: ')
    assert len(out.strip().splitlines()) == 1
    assert commit_count(repo) == 1


def test_missing_handoff_folder_is_not_reported_as_no_repository(repo, run):
    msg = repo.parent / 'msg.txt'; msg.write_text('m', encoding='utf-8')
    out = go(run, repo / 'no-such-folder' / 'H.md', msg, cwd=repo)
    assert out.strip() == f'COMMIT_FAILED: handoff folder not found: {repo / "no-such-folder"}'


def test_git_failing_midway_is_reported_not_taken_for_an_answer(repo, run):
    # A damaged index makes git exit 128 on the first question it asks of the index.
    hp, msg = setup(repo)
    (repo / '.git/index').write_bytes(b'this is not an index')
    out = go(run, hp, msg, cwd=repo).strip()
    assert out.startswith('COMMIT_FAILED: git ls-files -u: ')
    assert len(out.splitlines()) == 1
    assert commit_count(repo) == 1  # rev-list does not read the index, so it works on the damaged repository


@pytest.mark.skipif(os.name == 'nt', reason='a colon is not allowed in a Windows file name')
def test_check_ignore_failing_is_reported_not_taken_for_not_ignored(repo, run):
    # `:(bad)x` is read by git as a path with unknown "magic": check-ignore exits 128 on it.
    # That is not "this file is not ignored".
    hp, msg = setup(repo)
    out = go(run, hp, msg, ':(bad)x', cwd=repo).strip()
    assert out.startswith('COMMIT_FAILED: git check-ignore: ')
    assert len(out.splitlines()) == 1
    assert commit_count(repo) == 1


def test_git_not_installed_is_reported(repo, run, tmp_path):
    hp, msg = setup(repo)
    out = go(run, hp, msg, cwd=repo, env={'PATH': str(tmp_path / 'folder-without-git')})
    assert out.strip() == 'COMMIT_FAILED: git is not installed'


def test_git_error_other_than_not_a_repository_is_reported_as_failure(tmp_path, run):
    broken = tmp_path / 'broken'; broken.mkdir()
    (broken / '.git').write_text('garbage\n', encoding='utf-8')  # a .git file git cannot parse
    hp = broken / 'H.md'; hp.write_text('x', encoding='utf-8')
    msg = tmp_path / 'm.txt'; msg.write_text('m', encoding='utf-8')
    out = go(run, hp, msg, cwd=broken).strip()
    assert out.startswith('COMMIT_FAILED: fatal: invalid gitfile format: ') and out.endswith('.git')
    assert len(out.splitlines()) == 1


# --- fix round 1: .env*, secret folders, repository root, staged deletions, unfinished operations ---

ROOT_LINE = 'SKIPPED_UNRELATED: . (repository root is never expanded)'  # wording: controller's ruling, progress.md


def test_env_family_names_are_secrets(repo, run):
    hp, msg = setup(repo)
    secret_names = ['.envrc', '.env-local', '.environment', '.envrc.local']
    for n in secret_names + ['environment.ts']:
        (repo / n).write_text('x', encoding='utf-8')
    out = go(run, hp, msg, *secret_names, 'environment.ts', cwd=repo)
    assert sorted(skipped(out)) == sorted(f'SKIPPED_SECRET: {n}' for n in secret_names)
    assert committed(repo) == sorted([INDEX, HANDOFF, 'environment.ts'])


def test_files_under_secret_named_folders_are_skipped(repo, run):
    hp, msg = setup(repo)
    names = ['secrets/db.yml', 'config/credentials/gcp.json', '.envs/.production/.django']
    for n in names + ['config/app.yml']:
        (repo / n).parent.mkdir(parents=True, exist_ok=True)
        (repo / n).write_text('x', encoding='utf-8')
    out = go(run, hp, msg, *names, 'config/app.yml', cwd=repo)
    assert sorted(skipped(out)) == sorted(f'SKIPPED_SECRET: {n}' for n in names)
    assert committed(repo) == sorted([INDEX, HANDOFF, 'config/app.yml'])


def test_secret_folder_found_while_expanding_a_folder(repo, run):
    hp, msg = setup(repo)
    for n in ['config/app.yml', 'config/credentials/gcp.json']:
        (repo / n).parent.mkdir(parents=True, exist_ok=True)
        (repo / n).write_text('x', encoding='utf-8')
    out = go(run, hp, msg, 'config', cwd=repo)
    assert skipped(out) == ['SKIPPED_SECRET: config/credentials/gcp.json']
    assert committed(repo) == sorted([INDEX, HANDOFF, 'config/app.yml'])


def test_handoff_and_index_are_committed_even_inside_a_secret_named_folder(repo, run):
    h = repo / 'services/credentials/.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t_x_2026-10-08.md').write_text('# h\n', encoding='utf-8')
    (h / 'INDEX.md').write_text('# Handoff Index\n', encoding='utf-8')
    msg = repo.parent / 'msg.txt'; msg.write_text('session: x [t]\n', encoding='utf-8')
    out = go(run, h / 'HANDOFF_t_x_2026-10-08.md', msg, cwd=repo)
    assert skipped(out) == []
    assert committed(repo) == sorted(['services/credentials/.claude/handoffs/HANDOFF_t_x_2026-10-08.md',
                                      'services/credentials/.claude/handoffs/INDEX.md'])


@pytest.mark.parametrize('root_forms', [['.'], [''], ['./'], ['.', './', '']], ids=['dot', 'empty', 'dot-slash', 'all-three'])
def test_repository_root_is_never_expanded(repo, run, root_forms):
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('changed', encoding='utf-8')
    (repo / 'other.txt').write_text('not asked for', encoding='utf-8')
    (repo / 'named.txt').write_text('asked for', encoding='utf-8')
    out = go(run, hp, msg, *root_forms, 'named.txt', cwd=repo)
    # the root line once, however many spellings of the root were given; a.txt and other.txt
    # are changed but were never named
    assert sorted(skipped(out)) == sorted([ROOT_LINE, 'SKIPPED_UNRELATED: a.txt', 'SKIPPED_UNRELATED: other.txt'])
    assert committed(repo) == sorted([INDEX, HANDOFF, 'named.txt'])


def stage_old_file(repo, name='old.txt'):
    (repo / name).write_text('some content\n' * 5, encoding='utf-8')
    git(repo, 'add', name); git(repo, 'commit', '-qm', f'add {name}')


def head_files(repo):
    return sorted(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').splitlines())


def test_staged_deletion_asked_for_is_committed(repo, run):
    stage_old_file(repo)
    git(repo, 'rm', '-q', 'old.txt')
    hp, msg = setup(repo)
    out = go(run, hp, msg, 'old.txt', cwd=repo)
    assert skipped(out) == []  # not SKIPPED_MISSING
    assert 'COMMITTED:' in out
    assert sorted(git(repo, 'show', '--name-status', '--format=', 'HEAD').splitlines()) == \
        sorted([f'A\t{INDEX}', f'A\t{HANDOFF}', 'D\told.txt'])
    assert head_files(repo) == sorted(['a.txt', INDEX, HANDOFF])


def test_staged_rename_with_both_names_asked_for(repo, run):
    stage_old_file(repo)
    git(repo, 'mv', 'old.txt', 'new.txt')
    hp, msg = setup(repo)
    out = go(run, hp, msg, 'old.txt', 'new.txt', cwd=repo)
    assert skipped(out) == []
    assert 'COMMITTED:' in out
    assert head_files(repo) == sorted(['a.txt', 'new.txt', INDEX, HANDOFF])  # old.txt is gone from HEAD
    assert git(repo, 'diff', '--cached', '--name-only') == ''


def test_staged_rename_with_only_the_new_name_asked_for_reports_the_old_one(repo, run):
    stage_old_file(repo)
    git(repo, 'mv', 'old.txt', 'new.txt')
    hp, msg = setup(repo)
    out = go(run, hp, msg, 'new.txt', cwd=repo)
    assert skipped(out) == ['SKIPPED_UNRELATED: old.txt']
    assert 'COMMITTED:' in out
    # new.txt went in, the deletion of old.txt did not: HEAD still has both, the deletion stays staged
    assert head_files(repo) == sorted(['a.txt', 'old.txt', 'new.txt', INDEX, HANDOFF])
    assert git(repo, 'diff', '--cached', '--name-only').splitlines() == ['old.txt']


def test_staged_deletions_inside_a_folder_asked_for(repo, run):
    for n in ['dir/x.txt', 'dir/sub/y.txt', 'dir/keep.txt']:
        (repo / n).parent.mkdir(parents=True, exist_ok=True)
        (repo / n).write_text('v\n', encoding='utf-8')
    git(repo, 'add', 'dir'); git(repo, 'commit', '-qm', 'dir')
    git(repo, 'rm', '-q', 'dir/x.txt', 'dir/sub/y.txt')  # keep.txt stays: the folder still exists
    hp, msg = setup(repo)
    out = go(run, hp, msg, 'dir', cwd=repo)
    assert skipped(out) == []
    assert sorted(git(repo, 'show', '--name-status', '--format=', 'HEAD').splitlines()) == \
        sorted([f'A\t{INDEX}', f'A\t{HANDOFF}', 'D\tdir/x.txt', 'D\tdir/sub/y.txt'])


def test_staged_deletion_of_a_folder_that_is_gone_from_the_disk(repo, run):
    for n in ['dir/x.txt', 'dir/y.txt']:
        (repo / n).parent.mkdir(parents=True, exist_ok=True)
        (repo / n).write_text('v\n', encoding='utf-8')
    git(repo, 'add', 'dir'); git(repo, 'commit', '-qm', 'dir')
    git(repo, 'rm', '-rq', 'dir')
    hp, msg = setup(repo)
    out = go(run, hp, msg, 'dir', cwd=repo)
    assert skipped(out) == []
    assert head_files(repo) == sorted(['a.txt', INDEX, HANDOFF])


def test_deletion_alone_is_committed_when_handoff_and_index_are_ignored(repo, run):
    # Nothing is left to give to `git add`, yet the staged deletion is committed.
    stage_old_file(repo)
    git(repo, 'rm', '-q', 'old.txt')
    hp, msg = setup(repo)
    (repo / '.gitignore').write_text('.claude/\n', encoding='utf-8')  # handoff and INDEX.md ignored
    out = go(run, hp, msg, 'old.txt', cwd=repo)
    assert sorted(skipped(out)) == sorted([f'SKIPPED_IGNORED: {HANDOFF}', f'SKIPPED_IGNORED: {INDEX}',
                                           'SKIPPED_UNRELATED: .gitignore'])
    assert 'COMMITTED:' in out  # only the deletion is picked, so `git add` has nothing to do
    assert committed(repo) == ['old.txt']


def conflicting_branches(repo):
    """a.txt is 'side' on branch side and 'main' on the branch we stay on; both committed.
    Returns the commit we stay on."""
    git(repo, 'checkout', '-q', '-b', 'side')
    (repo / 'a.txt').write_text('side\n', encoding='utf-8')
    git(repo, 'commit', '-qam', 'side change')
    git(repo, 'checkout', '-q', '-')
    (repo / 'a.txt').write_text('main\n', encoding='utf-8')
    git(repo, 'commit', '-qam', 'main change')
    return git(repo, 'rev-parse', 'HEAD').strip()


def independent_branches(repo):
    """side adds side.txt, the branch we stay on adds main.txt: no conflict between them.
    Returns the commit we stay on."""
    git(repo, 'checkout', '-q', '-b', 'side')
    (repo / 'side.txt').write_text('s\n', encoding='utf-8')
    git(repo, 'add', 'side.txt'); git(repo, 'commit', '-qm', 'side change')
    git(repo, 'checkout', '-q', '-')
    (repo / 'main.txt').write_text('m\n', encoding='utf-8')
    git(repo, 'add', 'main.txt'); git(repo, 'commit', '-qm', 'main change')
    return git(repo, 'rev-parse', 'HEAD').strip()


def merge_conflict(repo):
    conflicting_branches(repo)
    git(repo, 'merge', 'side')


def merge_stopped_without_conflict(repo):
    independent_branches(repo)
    git(repo, 'merge', '--no-commit', '--no-ff', 'side')


def cherry_pick_conflict(repo):
    conflicting_branches(repo)
    git(repo, 'cherry-pick', 'side')


def revert_conflict(repo):
    (repo / 'a.txt').write_text('x\n', encoding='utf-8'); git(repo, 'commit', '-qam', 'x')
    (repo / 'a.txt').write_text('y\n', encoding='utf-8'); git(repo, 'commit', '-qam', 'y')
    git(repo, 'revert', '--no-edit', 'HEAD~1')


def rebase_conflict(repo):
    main = conflicting_branches(repo)
    git(repo, 'checkout', '-q', 'side')
    git(repo, 'rebase', main)


def rebase_stopped_without_conflict(repo):
    main = independent_branches(repo)
    git(repo, 'checkout', '-q', 'side')
    git(repo, 'rebase', '-x', 'false', main)  # the exec step fails, the rebase stops there


def stash_pop_conflict(repo):
    (repo / 'a.txt').write_text('stash\n', encoding='utf-8')
    git(repo, 'stash', '-q')
    (repo / 'a.txt').write_text('new\n', encoding='utf-8')
    git(repo, 'commit', '-qam', 'new')
    git(repo, 'stash', 'pop')


def marker_cherry_pick_head(repo):
    (repo / '.git/CHERRY_PICK_HEAD').write_text(git(repo, 'rev-parse', 'HEAD'), encoding='utf-8')


def marker_revert_head(repo):
    (repo / '.git/REVERT_HEAD').write_text(git(repo, 'rev-parse', 'HEAD'), encoding='utf-8')


def marker_rebase_apply(repo):
    (repo / '.git/rebase-apply').mkdir()


# name -> (builder, git-dir entry that must exist afterwards or None, must the index hold unmerged paths)
UNFINISHED = {
    'merge-conflict': (merge_conflict, 'MERGE_HEAD', True),
    'merge-stopped-without-conflict': (merge_stopped_without_conflict, 'MERGE_HEAD', False),
    'cherry-pick-conflict': (cherry_pick_conflict, 'CHERRY_PICK_HEAD', True),
    'revert-conflict': (revert_conflict, 'REVERT_HEAD', True),
    'rebase-conflict': (rebase_conflict, 'rebase-merge', True),
    'rebase-stopped-without-conflict': (rebase_stopped_without_conflict, 'rebase-merge', False),
    'stash-pop-conflict': (stash_pop_conflict, None, True),
    'marker-cherry-pick-head': (marker_cherry_pick_head, 'CHERRY_PICK_HEAD', False),
    'marker-revert-head': (marker_revert_head, 'REVERT_HEAD', False),
    'marker-rebase-apply': (marker_rebase_apply, 'rebase-apply', False),
}


@pytest.mark.parametrize('name', list(UNFINISHED))
def test_unfinished_operation_leaves_the_index_alone(repo, run, name):
    build, marker, unmerged = UNFINISHED[name]
    build(repo)
    # the scenario really is what its name says (otherwise the test below proves nothing)
    if marker:
        assert (repo / '.git' / marker).exists(), name
    assert (git(repo, 'ls-files', '-u') != '') == unmerged, name
    hp, msg = setup(repo)
    (repo / 'a.txt').write_text('asked for', encoding='utf-8')
    before = (git(repo, 'ls-files', '-s'), git(repo, 'ls-files', '-u'),
              git(repo, 'diff', '--cached', '--name-only'), git(repo, 'rev-parse', 'HEAD'))
    out = go(run, hp, msg, 'a.txt', cwd=repo)
    assert out == 'COMMIT_FAILED: merge or rebase in progress — commit skipped, index untouched\n'
    after = (git(repo, 'ls-files', '-s'), git(repo, 'ls-files', '-u'),
             git(repo, 'diff', '--cached', '--name-only'), git(repo, 'rev-parse', 'HEAD'))
    assert after == before
    assert (after[1] != '') == unmerged  # a conflict is still a conflict
