"""Shared fixtures for the handoff scripts tests: repo, make_repo, run, run_fail.

repo       tmp_path turned into a git repository with one commit (a.txt)
make_repo  the same for any path: make_repo(path) -> path
run        run(script, *args, cwd=..., env=None) -> stdout of `python3 -I <script>`; fails on non-zero exit
run_fail   run_fail(script, *args, cwd=..., env=None) -> stderr + stdout; fails on zero exit
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parents[1] / 'skills/handoff/scripts'


def _git(cwd, *args):
    # Keeps the machine's global git config out of the fixture repos (a global commit hook
    # could break `git commit`). GIT_CONFIG_GLOBAL is honoured by git 2.32 and newer only.
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
    subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True,
                   text=True, encoding='utf-8', env=env)


def _init_repo(path):
    """git init + one commit (a.txt) in `path`, creating the folder if needed."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    _git(path, 'init', '-q')
    _git(path, 'config', 'user.email', 'test@example.com')
    _git(path, 'config', 'user.name', 'Test')
    _git(path, 'config', 'commit.gpgsign', 'false')
    (path / 'a.txt').write_text('a\n', encoding='utf-8')
    _git(path, 'add', 'a.txt')
    _git(path, 'commit', '-q', '-m', 'init')
    return path


@pytest.fixture
def repo(tmp_path):
    return _init_repo(tmp_path)


@pytest.fixture
def make_repo():
    return _init_repo


def _exec(tmp_path, script, args, cwd, env_extra=None):
    # GIT_CEILING_DIRECTORIES = the parent of the test's temp folder: git does not search
    # that parent or anything above it, so a "no git" test finds no repository even when
    # the machine's temp folder sits inside one (checked by hand: with the variable set,
    # a child folder of a repository reports NOT_GIT).
    env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(tmp_path.parent), **(env_extra or {}))
    return subprocess.run(
        [sys.executable, '-I', str(SCRIPTS / script), *[str(a) for a in args]],
        cwd=str(cwd), capture_output=True, text=True, encoding='utf-8', env=env, timeout=60)


@pytest.fixture
def run(tmp_path):
    """run(script, *args, cwd=..., env=None) -> stdout; fails the test on a non-zero exit.
    env: optional dict of environment variables added to (or replacing) the inherited ones."""
    def _run(script, *args, cwd, env=None):
        r = _exec(tmp_path, script, args, cwd, env)
        assert r.returncode == 0, f'{script} exited {r.returncode}\nSTDERR:\n{r.stderr}\nSTDOUT:\n{r.stdout}'
        return r.stdout
    return _run


@pytest.fixture
def run_fail(tmp_path):
    """run_fail(script, *args, cwd=..., env=None) -> stderr + stdout; fails the test on a zero exit."""
    def _run_fail(script, *args, cwd, env=None):
        r = _exec(tmp_path, script, args, cwd, env)
        assert r.returncode != 0, f'{script} was expected to fail but exited 0\nSTDOUT:\n{r.stdout}'
        return r.stderr + r.stdout
    return _run_fail
