import importlib.util
import os
import re
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parents[1] / 'skills/handoff/scripts'


def lines(out):
    return dict(l.split(': ', 1) for l in out.splitlines() if ': ' in l and not l.startswith('---'))


def between(out, start, end=None):
    """Output lines after the line that starts with `start`, up to the line that starts with `end`
    (or the end of the output)."""
    got, on = [], False
    for l in out.splitlines():
        if on and end is not None and l.startswith(end):
            break
        if on:
            got.append(l)
        elif l.startswith(start):
            on = True
    assert on, f'no line starting with {start!r} in output:\n{out}'
    return got


def git_out(cwd, *args, env=None):
    # Same isolation as the fixtures in conftest.py: the user's global git config stays out.
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1', **(env or {}))
    r = subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True,
                       encoding='utf-8', env=env)
    return r.stdout


def load_gather():
    spec = importlib.util.spec_from_file_location('gather_under_test', SCRIPTS / 'gather.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- tests from the task brief -------------------------------------------------------------

def test_gather_git_defaults_to_docs_handoffs(repo, run):
    d = lines(run('gather.py', cwd=repo))
    assert d['ROOT'] == str(repo)
    assert 'NOT_GIT' not in d
    assert 'GIT_ERROR' not in d
    assert d['HANDOFF_DIR'] == f"{repo / 'docs' / 'handoffs'} (does not exist yet — create it)"
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
    assert d['HANDOFF_DIR'].startswith(str(tmp_path / 'docs' / 'handoffs'))


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


# --- handoff folder rule (spec F-10) --------------------------------------------------------

def test_gather_dir_all_four_exist_first_one_wins(repo, run):
    for rel in ('docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs'):
        (repo / rel).mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'] == str(repo / 'docs' / 'superpowers' / 'handoffs')


def test_gather_existing_dir_beats_superpowers_default(repo, run):
    # docs/superpowers exists but has no handoffs/ inside; plans/handoffs does exist: it wins.
    (repo / 'docs/superpowers').mkdir(parents=True)
    (repo / 'plans/handoffs').mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'] == str(repo / 'plans' / 'handoffs')


def test_gather_docs_handoffs_beats_old_claude_handoffs(repo, run):
    # spec F-10: docs/handoffs comes before .claude/handoffs in the list
    (repo / 'docs/handoffs').mkdir(parents=True)
    (repo / '.claude/handoffs').mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'] == str(repo / 'docs' / 'handoffs')


def test_gather_old_claude_handoffs_still_found_when_it_is_the_only_one(repo, run):
    (repo / '.claude/handoffs').mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'] == str(repo / '.claude' / 'handoffs')


def test_gather_no_git_ignores_existing_plans_handoffs(tmp_path, run):
    # spec F-10: without git the folder is <current folder>/docs/handoffs, whatever else exists
    (tmp_path / 'plans/handoffs').mkdir(parents=True)
    d = lines(run('gather.py', cwd=tmp_path))
    assert d['NOT_GIT'].startswith('yes')
    assert d['HANDOFF_DIR'] == f"{tmp_path / 'docs' / 'handoffs'} (does not exist yet — create it)"


def test_gather_existing_dir_has_no_create_hint(repo, run):
    (repo / '.claude/handoffs').mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['HANDOFF_DIR'] == str(repo / '.claude' / 'handoffs')


# Expected values below are typed from spec F-10 (the four-name list and the two defaults), not
# taken from gather.py's output.
@pytest.mark.parametrize('existing', [
    [],
    ['docs/superpowers/handoffs'],
    ['plans/handoffs'],            # an existing plans/handoffs does NOT count outside git
    ['.claude/handoffs'],
    ['docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs'],
])
def test_pick_handoff_dir_without_git_is_always_docs_handoffs(tmp_path, existing):
    for rel in existing:
        (tmp_path / rel).mkdir(parents=True)
    assert load_gather().pick_handoff_dir(tmp_path, False) == tmp_path / 'docs' / 'handoffs'


@pytest.mark.parametrize('existing, expected', [
    ([], 'docs/handoffs'),
    (['docs/superpowers'], 'docs/superpowers/handoffs'),
    (['docs/superpowers', 'docs/handoffs'], 'docs/handoffs'),     # an existing folder beats the default
    (['plans/handoffs', '.claude/handoffs'], 'plans/handoffs'),
    (['plans/handoffs', 'docs/handoffs'], 'plans/handoffs'),
    (['docs/handoffs', '.claude/handoffs'], 'docs/handoffs'),     # docs/handoffs comes BEFORE .claude/handoffs
    (['.claude/handoffs'], '.claude/handoffs'),                   # only an old folder: keep using it
    (['docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs'],
     'docs/superpowers/handoffs'),
])
def test_pick_handoff_dir_with_git(tmp_path, existing, expected):
    for rel in existing:
        (tmp_path / rel).mkdir(parents=True)
    assert load_gather().pick_handoff_dir(tmp_path, True) == tmp_path.joinpath(*expected.split('/'))


def test_gather_no_git_reports_cwd_as_root_and_has_no_branch(tmp_path, run):
    d = lines(run('gather.py', cwd=tmp_path))
    assert d['ROOT'] == str(tmp_path)
    assert d['HANDOFF_DIR'] == f"{tmp_path / 'docs' / 'handoffs'} (does not exist yet — create it)"
    assert 'BRANCH' not in d
    assert 'GIT_ERROR' not in d  # "not a git repository" is the normal no-git case, not an error


def test_gather_no_git_lists_existing_handoffs(tmp_path, run):
    h = tmp_path / 'docs/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_x_2026-10-08.md').write_text('**Chain:** `x` seq `1`\n**Status:** DONE\n', encoding='utf-8')
    out = run('gather.py', cwd=tmp_path)
    assert lines(out)['HANDOFF_DIR'] == str(h)
    assert between(out, '--- newest handoffs', 'INDEX:') == ['HANDOFF_x_2026-10-08.md | `x` seq `1` | DONE']


# --- git is missing or fails ------------------------------------------------------------------

def test_gather_git_not_installed_is_reported(repo, run, tmp_path):
    # `repo` is a real repository, but git cannot be found: PATH points to a folder without it.
    d = lines(run('gather.py', cwd=repo, env={'PATH': str(tmp_path / 'folder-without-git')}))
    assert d['NOT_GIT'] == 'yes — git is not installed'
    assert d['ROOT'] == str(repo)
    assert 'GIT_ERROR' not in d
    assert 'BRANCH' not in d
    assert d['HANDOFF_DIR'].startswith(str(repo / 'docs' / 'handoffs'))


@pytest.mark.skipif(os.name == 'nt', reason='relies on POSIX execute permission bits')
def test_gather_git_that_cannot_be_started_is_a_git_error_not_missing(repo, run, tmp_path):
    fake_bin = tmp_path / 'fake-bin'; fake_bin.mkdir()
    (fake_bin / 'git').write_text('#!/bin/sh\n', encoding='utf-8')
    (fake_bin / 'git').chmod(0o644)  # a file called git is there, but it may not be executed
    d = lines(run('gather.py', cwd=repo, env={'PATH': str(fake_bin)}))
    assert d['GIT_ERROR'].startswith('[Errno 13] Permission denied')
    assert d['NOT_GIT'].startswith('yes') and d['NOT_GIT'] != 'yes — git is not installed'
    assert d['ROOT'] == str(repo)


def test_gather_git_failure_other_than_not_a_repository_is_reported(tmp_path, run):
    broken = tmp_path / 'broken'; broken.mkdir()
    (broken / '.git').write_text('garbage\n', encoding='utf-8')  # a .git file git cannot parse
    out = run('gather.py', cwd=broken)
    d = lines(out)
    assert [l for l in out.splitlines() if l.startswith('GIT_ERROR:')] == [f"GIT_ERROR: {d['GIT_ERROR']}"]
    assert d['GIT_ERROR'].startswith('fatal: invalid gitfile format: ') and d['GIT_ERROR'].endswith('.git')
    assert d['NOT_GIT'].startswith('yes')
    assert d['ROOT'] == str(broken)
    assert d['HANDOFF_DIR'].startswith(str(broken / 'docs' / 'handoffs'))
    assert 'BRANCH' not in d


def test_gather_dubious_ownership_is_reported(tmp_path, run, make_repo):
    # git's own test switch makes it treat the repository as owned by someone else, which is
    # exactly the "dubious ownership" refusal real users meet. Global config is replaced by
    # an empty one so a `safe.directory = *` in the user's config cannot hide the refusal.
    owned = make_repo(tmp_path / 'owned')
    env = {'GIT_TEST_ASSUME_DIFFERENT_OWNER': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
    probe = subprocess.run(['git', '-C', str(owned), 'rev-parse', '--show-toplevel'], capture_output=True,
                           text=True, encoding='utf-8', env=dict(os.environ, **env))
    if probe.returncode == 0:
        pytest.skip('this git ignores GIT_TEST_ASSUME_DIFFERENT_OWNER (it needs git 2.35.2 or newer)')
    d = lines(run('gather.py', cwd=owned, env=env))
    assert d['GIT_ERROR'].startswith('fatal: detected dubious ownership in repository at ')
    assert d['NOT_GIT'].startswith('yes')
    assert d['ROOT'] == str(owned)
    assert d['HANDOFF_DIR'].startswith(str(owned / 'docs' / 'handoffs'))


def test_gather_fresh_tags_differ_between_runs(repo, run):
    tags = {lines(run('gather.py', cwd=repo))['FRESH_STANDALONE_TAG'] for _ in range(3)}
    assert len(tags) == 3


# --- git state sections ---------------------------------------------------------------------

def test_gather_git_state_sections(repo, run):
    for i in range(16):  # init + 16 = 17 commits; the section must hold exactly 15
        git_out(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', f'step {i}')
    for i in range(32):  # 32 untracked files; the section must hold exactly 30
        (repo / f'u{i:02d}.txt').write_text('x\n', encoding='utf-8')
    out = run('gather.py', cwd=repo)
    d = lines(out)
    assert d['BRANCH'] == git_out(repo, 'branch', '--show-current').strip()
    commits = between(out, '--- recent commits', '--- uncommitted')
    assert len(commits) == 15
    assert commits[0].endswith(' step 15') and commits[-1].endswith(' step 1')
    uncommitted = between(out, '--- uncommitted', '--- diff stat')
    assert len(uncommitted) == 30
    assert uncommitted[0] == '?? u00.txt' and uncommitted[-1] == '?? u29.txt'


def test_gather_clean_repo_has_empty_uncommitted_and_diff_stat_sections(repo, run):
    out = run('gather.py', cwd=repo)
    assert between(out, '--- uncommitted', '--- diff stat') == []
    assert between(out, '--- diff stat', 'HANDOFF_DIR:') == []


def test_gather_diff_stat_is_last_line_of_git_diff_stat(repo, run):
    (repo / 'a.txt').write_text('a\nb\nc\n', encoding='utf-8')
    out = run('gather.py', cwd=repo)
    assert between(out, '--- diff stat', 'HANDOFF_DIR:') == [' 1 file changed, 2 insertions(+)']


def test_gather_latest_v_tag_newest_v_tag_wins(repo, run):
    def tag(name, date):
        git_out(repo, '-c', 'commit.gpgsign=false', 'tag', '-a', name, '-m', name,
                env={'GIT_COMMITTER_DATE': date, 'GIT_COMMITTER_NAME': 'T', 'GIT_COMMITTER_EMAIL': 't@e.x'})
    tag('v1.0', '2026-01-01T00:00:00')
    tag('v2.0', '2026-02-01T00:00:00')
    tag('release-9', '2026-03-01T00:00:00')  # newest of all, but not a v<digit> tag
    assert lines(run('gather.py', cwd=repo))['LATEST_V_TAG'] == 'v2.0'


def test_gather_latest_v_tag_empty_without_tags(repo, run):
    assert lines(run('gather.py', cwd=repo))['LATEST_V_TAG'] == ''


def test_gather_cyrillic_file_name_is_not_quoted(repo, run):
    (repo / 'файл.txt').write_text('x\n', encoding='utf-8')
    assert between(run('gather.py', cwd=repo), '--- uncommitted', '--- diff stat') == ['?? файл.txt']


# --- newest handoffs and INDEX --------------------------------------------------------------

def test_gather_newest_handoffs_max_five_by_mtime(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    # 7 files a..g; the mtime order (b, d, f, g, e, c, a) differs from the name order, so only a
    # real "newest by mtime, top 5" gives exactly b, d, f, g, e.
    mtimes = {'a': 100, 'b': 700, 'c': 200, 'd': 600, 'e': 300, 'f': 500, 'g': 400}
    for key, t in mtimes.items():
        p = h / f'HANDOFF_{key}_2026-10-08.md'
        p.write_text(f'**Chain:** `{key}` seq `1`\n**Status:** S-{key}\n', encoding='utf-8')
        os.utime(p, (t, t))
    got = between(run('gather.py', cwd=repo), '--- newest handoffs', 'INDEX:')
    assert got == [f'HANDOFF_{k}_2026-10-08.md | `{k}` seq `1` | S-{k}' for k in 'bdfge']


def test_gather_newest_handoffs_boundaries(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    # 0 handoffs: empty section; handoff without Chain/Status lines: empty fields.
    assert between(run('gather.py', cwd=repo), '--- newest handoffs', 'INDEX:') == []
    (h / 'HANDOFF_bare.md').write_text('no header lines\n', encoding='utf-8')
    (h / 'NOT_A_HANDOFF.md').write_text('**Chain:** `z`\n', encoding='utf-8')
    assert between(run('gather.py', cwd=repo), '--- newest handoffs', 'INDEX:') == ['HANDOFF_bare.md |  | ']


def test_gather_index_entry_count(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    assert lines(run('gather.py', cwd=repo))['INDEX'] == 'none'
    (h / 'INDEX.md').write_text(
        '# Handoff Index\n\n- [a seq 1 — t](A.md) — d; s; next: n\n'
        '- [a seq 2 — t](B.md) — d; s; next: n\nnot an entry\n- [b seq 1 — t](C.md) — d; s; next: n\n',
        encoding='utf-8')
    assert lines(run('gather.py', cwd=repo))['INDEX'] == f'{h / "INDEX.md"} (3 entries)'


# --- chain candidates -----------------------------------------------------------------------

def _chain_fixture(repo):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    where = ''.join(f'- g{i}\n\n' for i in range(1, 21))  # 20 items, a blank line after each
    files = {
        # mtimes contradict seq order; names contradict it too (aa < mm < zz alphabetically)
        'HANDOFF_t1_zz.md': ('**Chain:** `t1` seq `2`\n## Where We\'re Going\n- from zz\n', 300),
        'HANDOFF_t1_aa.md': (f'**Chain:** `t1` seq `10`\n## Summary\n- not this\n## Where We’re Going\n{where}## Later\n- after\n', 100),
        'HANDOFF_t1_mm.md': ('**Chain:** `t1`\n## Where We\'re Going\n- from mm\n', 200),
        'HANDOFF_t1_bb.md': ('**Chain:** `t1` seq `1`\n## Where We\'re Going\n- from bb\n', 250),
        'HANDOFF_t1_auto.md': ('**Chain:** `t1` seq `5`\n**Auto:** true\n## Where We\'re Going\n- from auto\n', 400),
        # another chain; its body names the tag in a "Chain:" line, but its header does not
        'HANDOFF_t2_other.md': ('**Chain:** `t2` seq `50`\nsee also Chain: `t1` notes\n', 500),
    }
    for name, (text, t) in files.items():
        (h / name).write_text(text, encoding='utf-8')
        os.utime(h / name, (t, t))
    return h


def test_gather_chain_candidates_sorted_numerically_and_filtered(repo, run):
    _chain_fixture(repo)
    out = run('gather.py', 't1', cwd=repo)
    assert "--- chain candidates for 't1', by seq ascending" in out.splitlines()
    got = between(out, "--- chain candidates for 't1'", "--- newest candidate's")
    # 6 files in; 5 qualify. The other chain is out even though its body has a "Chain: `t1`" line:
    # only the **Chain:** header counts. The auto-handoff (`**Auto:** true`) is a normal member.
    # Order: no seq (counts as 0), 1, 2, 5, 10 (numeric, not text order: "10" < "2" as text).
    # The no-seq file's name sorts after the seq-1 file's, so a tie at 1 would put bb first.
    assert got == ['HANDOFF_t1_mm.md | `t1`',
                   'HANDOFF_t1_bb.md | `t1` seq `1`',
                   'HANDOFF_t1_zz.md | `t1` seq `2`',
                   'HANDOFF_t1_auto.md | `t1` seq `5`',
                   'HANDOFF_t1_aa.md | `t1` seq `10`']


def test_gather_chain_where_going_from_newest_candidate_max_15(repo, run):
    _chain_fixture(repo)
    out = run('gather.py', 't1', cwd=repo)
    got = between(out, "--- newest candidate's 'Where We're Going' (max 15 lines): HANDOFF_t1_aa.md")
    # 20 items in the section (blank lines between them); only the first 15 non-empty lines, nothing
    # from other sections or other candidates. The heading in the file uses a typographic apostrophe.
    assert got == [f'- g{i}' for i in range(1, 16)]


def test_gather_chain_auto_handoff_is_a_candidate_and_can_be_the_parent(repo, run):
    # Auto-handoffs are full chain members: a chain made of them is not "none", and the newest
    # one (highest seq) is the parent even when a manual handoff of the chain is older.
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1_manual.md').write_text(
        '**Chain:** `t1` seq `1`\n## Where We\'re Going\n- from manual\n', encoding='utf-8')
    (h / 'HANDOFF_t1_auto_2026-10-08-101500.md').write_text(
        '**Chain:** `t1` seq `2`\n**Auto:** true\n## Where We\'re Going\n- from auto\n', encoding='utf-8')
    out = run('gather.py', 't1', cwd=repo)
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == [
        'HANDOFF_t1_manual.md | `t1` seq `1`',
        'HANDOFF_t1_auto_2026-10-08-101500.md | `t1` seq `2`']
    assert between(out, "--- newest candidate's 'Where We're Going' (max 15 lines): "
                        "HANDOFF_t1_auto_2026-10-08-101500.md") == ['- from auto']


def test_gather_chain_made_only_of_auto_handoffs_is_not_none(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1_auto.md').write_text('**Chain:** `t1` seq `1`\n**Auto:** true\n', encoding='utf-8')
    out = run('gather.py', 't1', cwd=repo)
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == [
        'HANDOFF_t1_auto.md | `t1` seq `1`']


def test_gather_chain_none(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t2_a.md').write_text('**Chain:** `t2` seq `1`\n', encoding='utf-8')
    # No **Chain:** header at all, only a body line that names the tag: not a candidate.
    (h / 'HANDOFF_nochain.md').write_text('notes\nChain: `t1` seq `3`\n', encoding='utf-8')
    out = run('gather.py', 't1', cwd=repo)
    assert between(out, "--- chain candidates for 't1'") == ['none']
    assert "--- newest candidate's" not in out


def test_gather_chain_where_going_stops_at_next_heading(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1_a.md').write_text(
        '**Chain:** `t1` seq `1`\n## Summary\n- before\n## Where We\'re Going\n- one\n\n   \n- two\n'
        '## Later\n- after\n', encoding='utf-8')
    out = run('gather.py', 't1', cwd=repo)
    assert between(out, "--- newest candidate's 'Where We're Going'") == ['- one', '- two']


def test_gather_chain_where_going_missing_section_prints_nothing(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1_a.md').write_text('**Chain:** `t1` seq `1`\n## Summary\n- s\n', encoding='utf-8')
    out = run('gather.py', 't1', cwd=repo)
    assert between(out, "--- newest candidate's 'Where We're Going'") == []


def test_gather_without_tag_has_no_chain_section(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1_a.md').write_text('**Chain:** `t1` seq `1`\n', encoding='utf-8')
    assert '--- chain candidates' not in run('gather.py', cwd=repo)


def test_gather_tag_without_handoff_dir_has_no_chain_section(repo, run):
    out = run('gather.py', 't1', cwd=repo)
    assert '--- chain candidates' not in out
    assert 'does not exist yet' in lines(out)['HANDOFF_DIR']


@pytest.mark.parametrize('tag, other', [
    ('t1', 't10'),                                       # longer name that starts with the tag
    ('t1', 't1-b'),                                      # tag followed by a hyphen
    ('t1', 'x-t1'),                                      # tag preceded by a hyphen
    ('t1', 'et1'),                                       # tag preceded by a letter
    ('t1', 't1_b'),                                      # tag followed by an underscore
    ('v1', 'v1.1'),                                      # version prefix
    ('v1.2', 'v1x2'),                                    # the dot in the tag is not a pattern
    ('сайт', 'сайт2'),                                   # non-ASCII word characters count as word
    ('standalone-ab12cd34', 'standalone-ab12cd345'),
    ('standalone-ab12cd34', 'standalone-ab12cd34-2'),
])
def test_gather_chain_tag_matches_whole_token_only(repo, run, tag, other):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_hit.md').write_text(f'**Chain:** `{tag}` seq `2`\n', encoding='utf-8')
    (h / 'HANDOFF_other.md').write_text(f'**Chain:** `{other}` seq `1`\n', encoding='utf-8')
    got = between(run('gather.py', tag, cwd=repo), f"--- chain candidates for '{tag}'", "--- newest candidate's")
    assert got == [f'HANDOFF_hit.md | `{tag}` seq `2`']


def test_gather_chain_tag_next_to_punctuation_matches(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    headers = ['`t1` seq `1`', 't1 seq 2', '`t1,t2` seq `3`', '(t1) seq 4', '[t1] seq 5', 't1']
    for i, header in enumerate(headers):
        (h / f'HANDOFF_p{i}.md').write_text(f'**Chain:** {header}\n', encoding='utf-8')
    got = between(run('gather.py', 't1', cwd=repo), "--- chain candidates for 't1'", "--- newest candidate's")
    # 6 files in, 6 candidates; seq 1..5 from the headers, the last file has no seq (counts as 0)
    assert got == ['HANDOFF_p5.md | t1'] + [f'HANDOFF_p{i}.md | {headers[i]}' for i in range(5)]


def test_gather_chain_tag_repeated_on_the_chain_line_still_matches(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_t1.md').write_text('**Chain:** `t1` seq `1` (renamed from t1-old)\n', encoding='utf-8')
    got = between(run('gather.py', 't1', cwd=repo), "--- chain candidates for 't1'", "--- newest candidate's")
    assert got == ['HANDOFF_t1.md | `t1` seq `1` (renamed from t1-old)']


def test_gather_chain_tag_is_plain_text_not_a_pattern(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    (h / 'HANDOFF_x.md').write_text('**Chain:** `abc` seq `1`\n', encoding='utf-8')
    (h / 'HANDOFF_y.md').write_text('**Chain:** `a.c` seq `1`\n', encoding='utf-8')
    got = between(run('gather.py', 'a.c', cwd=repo), "--- chain candidates for 'a.c'", "--- newest candidate's")
    assert got == ['HANDOFF_y.md | `a.c` seq `1`']


# --- --handoff-dir: the folder of the file the mod asked for (auto mode), not the current folder -------------
#
# Source of the expected values: the task brief (live bug 2026-10-11…13: the session started in a folder that is
# not a repository, the shell later moved into a nested repository, and the chain parent was looked up in the
# wrong place). Every value is typed from the files the test creates, not read back from gather.py's output.

def make_chain_file(folder, name, chain, where_going):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(f"**Chain:** {chain}\n## Where We're Going\n- {where_going}\n", encoding='utf-8')


def two_repos(tmp_path, make_repo, a_name='a', b_name='b'):
    """Repo A holds the handoffs (in x/docs/handoffs), repo B is where the command is run from and holds
    handoffs of the same chain `t1` that must NOT be read."""
    a = make_repo(tmp_path / a_name)
    b = make_repo(tmp_path / b_name)
    git_out(a, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'only in A')
    (a / 'a-only.txt').write_text('x\n', encoding='utf-8')
    git_out(b, 'branch', '-m', 'branch-of-b')
    make_chain_file(a / 'x/docs/handoffs', 'HANDOFF_t1_from-a.md', '`t1` seq `3`', 'step from A')
    make_chain_file(b / 'docs/handoffs', 'HANDOFF_t1_from-b.md', '`t1` seq `9`', 'step from B')
    return a, b


def test_gather_handoff_dir_wins_over_the_current_folder(tmp_path, run, make_repo):
    a, b = two_repos(tmp_path, make_repo)
    out = run('gather.py', 't1', '--handoff-dir', a / 'x/docs/handoffs', cwd=b)
    d = lines(out)
    assert d['ROOT'] == str(a)                                       # the repository of the folder, not of the cwd
    assert d['HANDOFF_DIR'] == str(a / 'x' / 'docs' / 'handoffs')    # exactly the given folder
    assert 'NOT_GIT' not in d and 'GIT_ERROR' not in d
    # git state is A's: its branch, its last commit, its untracked file; none of B's
    assert d['BRANCH'] == git_out(a, 'branch', '--show-current').strip()
    assert d['BRANCH'] != 'branch-of-b'
    commits = between(out, '--- recent commits', '--- uncommitted')
    assert [c.split(' ', 1)[1] for c in commits] == ['only in A', 'init']
    assert between(out, '--- uncommitted', '--- diff stat') == ['?? a-only.txt', '?? x/']
    # the chain is looked up in A's folder: one candidate, A's, with A's "Where We're Going"
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == ['HANDOFF_t1_from-a.md | `t1` seq `3`']
    assert between(out, "--- newest candidate's 'Where We're Going' (max 15 lines): HANDOFF_t1_from-a.md") == ['- step from A']
    assert 'from-b' not in out
    assert between(out, '--- newest handoffs', 'INDEX:') == ['HANDOFF_t1_from-a.md | `t1` seq `3` | ']


def test_gather_handoff_dir_option_may_come_first_and_the_tag_after(tmp_path, run, make_repo):
    a, b = two_repos(tmp_path, make_repo)
    out = run('gather.py', '--handoff-dir', a / 'x/docs/handoffs', 't1', cwd=b)
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == ['HANDOFF_t1_from-a.md | `t1` seq `3`']


def test_gather_without_the_option_still_reads_the_current_folder(tmp_path, run, make_repo):
    # the same two repositories: manual mode is unchanged and finds B's handoff, not A's
    a, b = two_repos(tmp_path, make_repo)
    out = run('gather.py', 't1', cwd=b)
    assert lines(out)['ROOT'] == str(b)
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == ['HANDOFF_t1_from-b.md | `t1` seq `9`']


def test_gather_handoff_dir_that_does_not_exist_yet_is_looked_at_through_its_parent(tmp_path, run, make_repo):
    # the first auto handoff of a project: neither docs/ nor docs/handoffs/ exists, but the repository does
    a, b = two_repos(tmp_path, make_repo)
    new = a / 'brand' / 'new' / 'handoffs'
    d = lines(run('gather.py', 't1', '--handoff-dir', new, cwd=b))
    assert d['ROOT'] == str(a)
    assert 'GIT_ERROR' not in d and 'NOT_GIT' not in d
    assert d['HANDOFF_DIR'] == f'{new} (does not exist yet — create it)'
    assert not new.exists()                                           # gather.py creates nothing


def test_gather_handoff_dir_outside_git_is_not_git_and_is_the_root(tmp_path, run, make_repo):
    b = make_repo(tmp_path / 'b')
    plain = tmp_path / 'plain'
    make_chain_file(plain / 'docs/handoffs', 'HANDOFF_t1_p.md', '`t1` seq `4`', 'step from plain')
    out = run('gather.py', 't1', '--handoff-dir', plain / 'docs/handoffs', cwd=b)
    d = lines(out)
    assert d['NOT_GIT'] == 'yes — no git repository found, using the given handoff folder'
    assert d['ROOT'] == str(plain / 'docs' / 'handoffs')
    assert d['HANDOFF_DIR'] == str(plain / 'docs' / 'handoffs')
    assert 'BRANCH' not in d and 'GIT_ERROR' not in d
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == ['HANDOFF_t1_p.md | `t1` seq `4`']


def test_gather_handoff_dir_not_git_and_not_existing_yet(tmp_path, run, make_repo):
    b = make_repo(tmp_path / 'b')
    plain = tmp_path / 'plain'; plain.mkdir()
    d = lines(run('gather.py', '--handoff-dir', plain / 'docs/handoffs', cwd=b))
    assert d['NOT_GIT'].startswith('yes')
    assert d['HANDOFF_DIR'] == f"{plain / 'docs' / 'handoffs'} (does not exist yet — create it)"


def test_gather_handoff_dir_with_spaces_and_cyrillic(tmp_path, run, make_repo):
    a = make_repo(tmp_path / 'Мои проекты' / 'сайт номер 2')
    b = make_repo(tmp_path / 'другой репозиторий')
    folder = a / 'документы' / 'передача смены'
    make_chain_file(folder, 'HANDOFF_сайт_итог.md', '`сайт` seq `1`', 'шаг из A')
    make_chain_file(b / 'docs/handoffs', 'HANDOFF_сайт_чужой.md', '`сайт` seq `5`', 'шаг из B')
    out = run('gather.py', 'сайт', '--handoff-dir', folder, cwd=b)
    d = lines(out)
    assert d['ROOT'] == str(a)
    assert d['HANDOFF_DIR'] == str(folder)
    assert between(out, "--- chain candidates for 'сайт'", "--- newest candidate's") == ['HANDOFF_сайт_итог.md | `сайт` seq `1`']
    assert between(out, "--- newest candidate's 'Where We're Going'") == ['- шаг из A']


def test_gather_handoff_dir_git_missing_is_reported_as_in_manual_mode(tmp_path, run, make_repo):
    a, b = two_repos(tmp_path, make_repo)
    d = lines(run('gather.py', 't1', '--handoff-dir', a / 'x/docs/handoffs', cwd=b, env={'PATH': str(tmp_path / 'no-git-here')}))
    assert d['NOT_GIT'] == 'yes — git is not installed'
    assert d['HANDOFF_DIR'] == str(a / 'x' / 'docs' / 'handoffs')


USAGE = 'usage: gather.py [chain_tag] [--handoff-dir ABSOLUTE_FOLDER | --root ABSOLUTE_FOLDER]'


@pytest.mark.parametrize('args, message', [
    (['--handoff-dir'], '--handoff-dir needs a folder'),
    (['--handoff-dir', ''], '--handoff-dir needs a folder'),
    (['--handoff-dir', 'docs/handoffs'], "--handoff-dir must be an absolute path, got 'docs/handoffs'"),
    (['t1', '--handoff-dir', 'x'], "--handoff-dir must be an absolute path, got 'x'"),
    (['--handoff-dr', '/tmp/x'], 'unknown option --handoff-dr'),
    (['--handoff-dir=/tmp/x'], 'unknown option --handoff-dir=/tmp/x'),
])
def test_gather_handoff_dir_bad_arguments_stop_with_a_usage_error(tmp_path, run_fail, make_repo, args, message):
    # a misspelt or relative folder must not quietly mean "the current folder"
    out = run_fail('gather.py', *args, cwd=make_repo(tmp_path / 'b'))
    assert out.splitlines()[0] == f'gather.py: {message}'
    assert out.splitlines()[1] == USAGE
    assert 'ROOT:' not in out


def test_gather_extra_words_after_the_tag_are_still_ignored(tmp_path, run, make_repo):
    # behaviour from before the option existed: only the first word is the tag
    a, b = two_repos(tmp_path, make_repo)
    out = run('gather.py', 't1', 'ignored', 'words', cwd=b)
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == ['HANDOFF_t1_from-b.md | `t1` seq `9`']


def test_gather_empty_first_word_is_the_tag_and_means_no_chain(tmp_path, run, make_repo):
    # `gather.py "" t1`: the first word (empty) is the tag, so there is no chain section; "t1" is an ignored extra word
    a, b = two_repos(tmp_path, make_repo)
    assert '--- chain candidates' not in run('gather.py', '', 't1', cwd=b)


def test_nearest_existing_walks_up_to_a_real_folder(tmp_path):
    g = load_gather()
    (tmp_path / 'one').mkdir()
    (tmp_path / 'file.txt').write_text('x', encoding='utf-8')
    assert g.nearest_existing(tmp_path / 'one') == tmp_path / 'one'
    assert g.nearest_existing(tmp_path / 'one' / 'two' / 'three') == tmp_path / 'one'
    assert g.nearest_existing(tmp_path / 'file.txt' / 'inside') == tmp_path                # a file is not a folder
    assert g.nearest_existing(tmp_path / 'file.txt') == tmp_path


# ---------- --root: manual mode looks at the folder the session started in ----------
# Live case 2026-10-15: the session started in a plain folder, Claude `cd`-ed into a nested repository, and a manual
# handoff landed in that repository while the chain's parent lay in the start folder. With --root (the session's
# start folder, which the handoff mod hands to the skill) manual mode looks where auto mode looks.

def test_gather_root_wins_over_the_current_folder(tmp_path, run, make_repo):
    a = make_repo(tmp_path / 'a')
    b = make_repo(tmp_path / 'b')
    make_chain_file(a / 'docs/handoffs', 'HANDOFF_t1_from-a.md', '`t1` seq `3`', 'step from A')
    make_chain_file(b / 'docs/handoffs', 'HANDOFF_t1_from-b.md', '`t1` seq `9`', 'step from B')
    out = run('gather.py', 't1', '--root', a, cwd=b)
    d = lines(out)
    assert d['ROOT'] == str(a)
    assert d['HANDOFF_DIR'] == str(a / 'docs' / 'handoffs')
    assert between(out, "--- chain candidates for 't1'", "--- newest candidate's") == ['HANDOFF_t1_from-a.md | `t1` seq `3`']
    assert 'from-b' not in out


def test_gather_root_inside_a_repository_uses_the_repository_root(tmp_path, run, make_repo):
    a = make_repo(tmp_path / 'a')
    (a / 'src' / 'deep').mkdir(parents=True)
    d = lines(run('gather.py', '--root', a / 'src' / 'deep', cwd=tmp_path))
    assert d['ROOT'] == str(a)
    assert d['HANDOFF_DIR'] == f"{a / 'docs' / 'handoffs'} (does not exist yet — create it)"


def test_gather_root_outside_git_is_the_root_and_holds_docs_handoffs(tmp_path, run, make_repo):
    # the live case: the start folder is not a repository, the nested one (where the shell is) is
    start = tmp_path / 'Мой проект'
    nested = make_repo(start / 'tender-automation')
    make_chain_file(start / 'docs/handoffs', 'HANDOFF_s_77.md', '`s` seq `77`', 'step 77')
    make_chain_file(nested / 'docs/superpowers/handoffs', 'HANDOFF_s_x.md', '`s` seq `5`', 'wrong place')
    out = run('gather.py', 's', '--root', start, cwd=nested)
    d = lines(out)
    assert d['NOT_GIT'] == 'yes — no git repository found, using the given session root'
    assert d['ROOT'] == str(start)
    assert d['HANDOFF_DIR'] == str(start / 'docs' / 'handoffs')
    assert 'BRANCH' not in d
    assert between(out, "--- chain candidates for 's'", "--- newest candidate's") == ['HANDOFF_s_77.md | `s` seq `77`']


@pytest.mark.parametrize('args, message', [
    (['--root'], '--root needs a folder'),
    (['--root', 'rel/dir'], "--root must be an absolute path, got 'rel/dir'"),
    (['--root', '/', '--handoff-dir', '/tmp/x'], '--root and --handoff-dir cannot be used together'),
    (['--handoff-dir', '/tmp/x', '--root', '/'], '--root and --handoff-dir cannot be used together'),
])
def test_gather_root_bad_arguments_stop_with_a_usage_error(tmp_path, run_fail, make_repo, args, message):
    out = run_fail('gather.py', *args, cwd=make_repo(tmp_path / 'b'))
    assert out.splitlines()[0] == f'gather.py: {message}'
    assert out.splitlines()[1] == USAGE
    assert 'ROOT:' not in out


def test_gather_root_that_does_not_exist_stops_with_a_usage_error(tmp_path, run_fail, make_repo):
    gone = tmp_path / 'gone'
    out = run_fail('gather.py', '--root', gone, cwd=make_repo(tmp_path / 'b'))
    assert out.splitlines()[0] == f'gather.py: --root folder does not exist: {gone}'
