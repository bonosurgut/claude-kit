import re


def entries_of(index_path):
    return [l for l in index_path.read_text(encoding='utf-8').splitlines() if l.startswith('- [')]


# --- tests from the task brief -------------------------------------------------------------

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


# --- more checks ----------------------------------------------------------------------------

def test_index_n_handoffs_in_n_entries_in_order_with_header_once(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    outs = []
    for i in range(3):
        p = h / f'HANDOFF_t_x{i}_2026-10-08.md'
        p.write_text('x\n' * (i + 1), encoding='utf-8')
        outs.append(run('index.py', str(p), 't', str(i + 1), '2026-10-08', 'IN PROGRESS',
                        'тема ' * 30, 'дальше ' * 30, cwd=repo))
    text = (h / 'INDEX.md').read_text(encoding='utf-8')
    assert text.count('# Handoff Index') == 1
    assert text.startswith('# Handoff Index\n\n')
    entries = entries_of(h / 'INDEX.md')
    assert len(entries) == 3
    for i, (e, out) in enumerate(zip(entries, outs)):
        assert f'(HANDOFF_t_x{i}_2026-10-08.md)' in e
        assert f't seq {i + 1} —' in e
        assert '…' in e  # inputs were 150 and 210 chars: they had to be clipped
        # stdout: INDEX (created only on the first run), APPENDED (<len of the written line>), line count
        out_lines = out.splitlines()
        assert out_lines[0] == f"INDEX: {'created ' if i == 0 else ''}{h / 'INDEX.md'}"
        assert out_lines[1] == f'APPENDED ({len(e)} chars): {e}'
        assert out_lines[2] == f'HANDOFF_LINES: {i + 1}'  # the file was written with i + 1 lines


def test_index_short_input_exact_line_and_whitespace_collapsed(repo, run):
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    p = h / 'HANDOFF_t_2026-10-08.md'; p.write_text('a\nb\n', encoding='utf-8')
    run('index.py', str(p), 't', '1', '2026-10-08', 'IN PROGRESS', 'тема   с\nпробелами', ' дальше ', cwd=repo)
    # Line format is the one of the original index.py (the user's script this one is ported from).
    assert entries_of(h / 'INDEX.md') == [
        '- [t seq 1 — тема с пробелами](HANDOFF_t_2026-10-08.md) — 2026-10-08; IN PROGRESS; next: дальше']


def test_index_limit_holds_while_fixed_part_is_at_most_180_then_goes_over(repo, run):
    # The docstring of index.py promises: <=200 chars while the line without TOPIC and NEXT is
    # <=180 chars; beyond that TOPIC and NEXT get 20 chars of room and the line exceeds the limit.
    h = repo / '.claude/handoffs'; h.mkdir(parents=True)
    p = h / 'HANDOFF_t.md'; p.write_text('x\n', encoding='utf-8')
    skeleton = len('- [t seq 1 — ](HANDOFF_t.md) — 2026-10-08; ; next: ')  # hand-counted without the status
    lengths = {}
    for fixed in (179, 180, 181):
        status = 'S' * (fixed - skeleton)
        out = run('index.py', str(p), 't', '1', '2026-10-08', status, 'тема ' * 40, 'дальше ' * 40, cwd=repo)
        lengths[fixed] = int(re.search(r'APPENDED \((\d+) chars\)', out).group(1))
    # 179: room 21 -> 200; 180: room 20 -> 200; 181: room is still 20 -> 201.
    assert lengths == {179: 200, 180: 200, 181: 201}
    assert [len(e) for e in entries_of(h / 'INDEX.md')] == [200, 200, 201]


def test_index_cyrillic_and_spaces_in_path(tmp_path, run, make_repo):
    r = make_repo(tmp_path / 'Мои проекты' / 'сайт')
    h = r / '.claude/handoffs'; h.mkdir(parents=True)
    p = h / 'HANDOFF_тест_2026-10-08.md'; p.write_text('строка 1\nстрока 2\n', encoding='utf-8')
    out = run('index.py', str(p), 'тест', '2', '2026-10-08', 'DONE', 'заголовок', 'дальше', cwd=r)
    assert entries_of(h / 'INDEX.md') == [
        '- [тест seq 2 — заголовок](HANDOFF_тест_2026-10-08.md) — 2026-10-08; DONE; next: дальше']
    assert out.splitlines()[2] == 'HANDOFF_LINES: 2'


def test_index_missing_handoff_creates_nothing(repo, run_fail):
    run_fail('index.py', str(repo / 'nope.md'), 't', '1', 'd', 's', 'a', 'b', cwd=repo)
    assert not (repo / 'INDEX.md').exists()


def test_index_wrong_argument_count_prints_usage(repo, run_fail):
    out = run_fail('index.py', 'only-one-arg', cwd=repo)
    assert 'Usage: python3 -I index.py HANDOFF_PATH CHAIN_TAG SEQ DATE STATUS "TOPIC" "NEXT"' in out
