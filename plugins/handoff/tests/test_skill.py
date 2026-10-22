"""Checks of SKILL.md against the things it talks about: the scripts, the mod and the spec.

SKILL.md is prose for a model, so these tests cannot prove the model obeys it. They prove the
statements that CAN be checked: the commands written in it run, the outcome words are the
ones the scripts print, the secret list is the script's, the header line parses the way the
mod parses it, the paste prompt is the agreed text. Where an expected value is typed in
here, its source is named next to it (task brief / plan / spec / the user's original skill),
never copied from SKILL.md itself.
"""
import fnmatch
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_DIR = Path(__file__).parents[1] / 'skills/handoff'
SKILL = SKILL_DIR / 'SKILL.md'
SCRIPTS = SKILL_DIR / 'scripts'
PLUGIN_JSON = Path(__file__).parents[1] / '.claude-plugin/plugin.json'
ISOLATED = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}


@pytest.fixture(scope='module')
def text():
    return SKILL.read_text(encoding='utf-8')


def load(name):
    spec = importlib.util.spec_from_file_location(f'{name}_for_skill_test', SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fences(text, lang=None):
    """Bodies of the fenced code blocks, optionally only those opened with ```<lang>."""
    out = []
    for m in re.finditer(r'^```(\w*)\n(.*?)^```$', text, re.M | re.S):
        if lang is None or m.group(1) == lang:
            out.append(m.group(2))
    return out


def section(text, heading):
    """Text from the line `heading` up to the next heading of the same or a higher level."""
    level = len(heading) - len(heading.lstrip('#'))
    lines = text.split('\n')
    start = lines.index(heading)
    end = len(lines)
    for i in range(start + 1, len(lines)):
        m = re.match(r'(#+) ', lines[i])
        if m and len(m.group(1)) <= level:
            end = i
            break
    return '\n'.join(lines[start:end])


# --- frontmatter ----------------------------------------------------------------------------

# Source: the user's original ~/.claude/skills/handoff/SKILL.md (brief: "same description triggers").
TRIGGERS = ['do a handoff', 'create a handoff', 'run handoff', 'save session', 'save session progress',
            'session handoff', 'running out of context', 'wrap up', 'wrap up for the day',
            'done for the day', 'end of day', 'pausing work', 'continue in a fresh session']


def frontmatter(text):
    """Frontmatter as {key: str}; a key with no value followed by `  - item` lines is {key: [items]}."""
    m = re.match(r'---\n(.*?)\n---\n', text, re.S)
    assert m, 'no frontmatter'
    out, last = {}, None
    for line in m.group(1).split('\n'):
        if line.startswith('  - '):
            assert isinstance(out[last], list), f'list item without a list key: {line!r}'
            out[last].append(line[4:])
        elif line.endswith(':') and ': ' not in line:
            last = line[:-1]
            out[last] = []
        else:
            last = line.split(': ', 1)[0]
            out[last] = line.split(': ', 1)[1]
    return out


def test_frontmatter_is_exactly_the_briefed_one(text):
    fm = frontmatter(text)
    assert sorted(fm) == ['allowed-tools', 'argument-hint', 'description', 'name', 'user-invocable']
    assert fm['name'] == 'handoff'
    assert fm['user-invocable'] == 'true'
    assert fm['argument-hint'] == '"[auto <path> | reason]"'   # brief, Step 1


def test_description_keeps_all_original_triggers_and_adds_none(text):
    desc = frontmatter(text)['description']
    quoted = re.findall(r'"([^"]+)"', desc)
    assert quoted == TRIGGERS
    assert 'Do NOT trigger when the user is only discussing, asking about, or editing an existing handoff file' in desc


# --- permission rules: `allowed-tools` (fix round 1) -------------------------------------------------
#
# Why they exist: in the default permission mode every script call and every file write of the skill
# asks the user. An automatic handoff starts while nobody is there, so it would wait for an answer
# until the mod gives up (15 minutes). Live runs of this fix round (`claude -p`, default mode, see
# task-6-report.md "Fix round 1"): without these rules 3 permission denials (gather.py twice, the
# handoff Write); with them none, and the handoff was written and committed.
#
# These tests cannot see what Claude Code really honors (the live runs did). They pin what is ours:
# the exact set of rules, and that the commands and file names the SKILL.md text tells the model to
# use are matched by exactly the intended rule and nothing wider. The matcher below is a model of
# the documented wildcard (`*` = any characters); the compound-command splitting Claude Code does
# before matching is not modelled.

SCRIPT_NAMES = ['gather', 'index', 'commit']
INTERPRETERS = ['python3 -I', 'py -3 -I', 'python -I']
# Source: task-6-fix1-findings.md, decision (A): the three scripts in the macOS/Linux form, the
# Windows form and the `python -I` fallback of the Scripts paragraph, plus the file writes the
# skill does: the handoff, the edit of its Commit line after a failed commit (Step 5), the
# commit-message file.
EXPECTED_ALLOWED = ([f'Bash({i} *handoff*{n}.py*)' for i in INTERPRETERS for n in SCRIPT_NAMES]
                    + ['Write(//**/HANDOFF_*.md)', 'Edit(//**/HANDOFF_*.md)',
                       'Write(//**/handoff-commit-msg-*.txt)'])

# Folders the skill can be installed in (the installed cache layout, a path with spaces and
# Cyrillic, a development checkout) and the Windows form.
POSIX_BASES = ['/Users/anna/.claude/plugins/cache/claude-kit/handoff/0.1.0/skills/handoff',
               '/Users/Анна Иванова/.claude/plugins/cache/claude-kit/handoff/0.1.0/skills/handoff',
               '/home/dev/claude-kit/plugins/handoff/skills/handoff']
WINDOWS_BASE = r'C:\Users\Anna\.claude\plugins\cache\claude-kit\handoff\0.1.0\skills\handoff'


def bash_rule_matches(rule, command):
    m = re.fullmatch(r'Bash\((.*)\)', rule)
    return bool(m) and re.fullmatch('.*'.join(map(re.escape, m.group(1).split('*'))), command, re.S) is not None


def file_rule_matches(rule, tool, path):
    """`Tool(//**/NAME-GLOB)`: any absolute path whose last part matches NAME-GLOB."""
    m = re.fullmatch(rf'{tool}\(//\*\*/([^/]+)\)', rule)
    return bool(m) and path.startswith('/') and fnmatch.fnmatchcase(path.rsplit('/', 1)[1], m.group(1))


def test_allowed_tools_is_exactly_the_scripts_and_the_files_it_writes(text):
    rules = frontmatter(text)['allowed-tools']
    assert rules == EXPECTED_ALLOWED
    assert len(set(rules)) == len(rules)


def test_no_rule_is_a_bare_tool_name_or_a_catch_all(text):
    # A bare `Bash` / `Write` (or `Bash(*)`) would let the model run or write anything while the skill is active.
    for rule in frontmatter(text)['allowed-tools']:
        m = re.fullmatch(r'(Bash|Write|Edit)\((.+)\)', rule)
        assert m, rule
        assert m.group(2).strip('*') != '', rule
        assert not m.group(2).startswith('*'), rule


def documented_commands(text):
    """(interpreter, script, command) for every form of every script command the text documents."""
    out = []
    for name in SCRIPT_NAMES:
        mac = command_template(text, f'{name}.py')            # python3 -I "<base>/scripts/NAME.py" ...
        tail = ' '.join(shlex.quote(t) if ' ' in t else t for t in mac[3:])
        for base in POSIX_BASES:
            for interp in ('python3 -I', 'python -I'):
                out.append((interp, name, f'{interp} "{base}/scripts/{name}.py" {tail}'.rstrip()))
        # Windows form: spelled out in the Scripts paragraph; `python -I` is its fallback
        assert 'py -3 -I "<base>\\scripts\\<name>.py"' in text
        for interp in ('py -3 -I', 'python -I'):
            out.append((interp, name, f'{interp} "{WINDOWS_BASE}\\scripts\\{name}.py" {tail}'.rstrip()))
    return out


def test_every_documented_script_command_is_matched_by_exactly_its_own_rule(text):
    rules = [r for r in frontmatter(text)['allowed-tools'] if r.startswith('Bash(')]
    cmds = documented_commands(text)
    assert len(cmds) == 3 * (len(POSIX_BASES) * 2 + 2)     # 3 scripts x (3 folders x 2 interpreters + 2 Windows forms)
    for interp, name, cmd in cmds:
        assert [r for r in rules if bash_rule_matches(r, cmd)] == [f'Bash({interp} *handoff*{name}.py*)'], cmd


@pytest.mark.parametrize('command', [
    'python3 -I /tmp/evil.py',
    'python3 -I "/tmp/gather.py"',                                    # not inside a handoff folder
    f'python3 -I "{POSIX_BASES[0]}/scripts/other.py"',                # another script
    f'python3 "{POSIX_BASES[0]}/scripts/gather.py"',                  # without -I (the skill always passes -I)
    'python3 -c "import os"',
    'python3 -m http.server',
    'python3 -I',
    'python3',
    'python -I -c "print(1)"',
    f'rm -rf "{POSIX_BASES[0]}/scripts/gather.py"',
    f'bash -c \'python3 -I "{POSIX_BASES[0]}/scripts/gather.py"\'',    # wrapped: the command must START with the interpreter
    'git push',
    'git commit -am x',
    'cat ~/.ssh/id_rsa',
])
def test_allowed_bash_rules_do_not_open_anything_else(text, command):
    rules = [r for r in frontmatter(text)['allowed-tools'] if r.startswith('Bash(')]
    assert [r for r in rules if bash_rule_matches(r, command)] == []


def names_from_the_text(text):
    """File names the text tells the model to use, with the placeholders filled in."""
    step3 = section(text, '## Step 3: Write the file — ONE turn')
    manual = re.search(r'\*\*Name\*\* \(manual mode\): `(HANDOFF_[^`]+\.md)`', step3).group(1)
    auto = re.search(r'`(HANDOFF_auto_YYYY[^`]+\.md)`', step3).group(1)
    msg = re.search(r'named `(handoff-commit-msg-[^`]+\.txt)`', section(text, '## Step 5: Commit — silently, no question')).group(1)
    return (manual.replace('{chain_tag}', 'v1.2-x').replace('{slug}', 'fix-it').replace('{YYYY-MM-DD}', '2026-10-09'),
            auto.replace('YYYY-MM-DD-HHMMSS', '2026-10-09-120000'),
            msg.replace('{slug}', 'fix-it'))


def test_file_names_the_text_asks_for_are_allowed_to_be_written(text):
    rules = frontmatter(text)['allowed-tools']
    manual, auto, msg = names_from_the_text(text)
    assert (manual, auto, msg) == ('HANDOFF_v1.2-x_fix-it_2026-10-09.md', 'HANDOFF_auto_2026-10-09-120000.md',
                                   'handoff-commit-msg-fix-it.txt')
    for folder in ('/r/docs/handoffs', '/r/docs/superpowers/handoffs', '/Users/Анна/мой проект/plans/handoffs'):
        for name in (manual, auto):
            assert [r for r in rules if file_rule_matches(r, 'Write', f'{folder}/{name}')] == ['Write(//**/HANDOFF_*.md)']
            assert [r for r in rules if file_rule_matches(r, 'Edit', f'{folder}/{name}')] == ['Edit(//**/HANDOFF_*.md)']
    # the message file: written (never edited), anywhere outside the repository
    for folder in ('/tmp', '/private/tmp/claude-501/scratchpad', '/var/folders/vg/T'):
        assert [r for r in rules if file_rule_matches(r, 'Write', f'{folder}/{msg}')] == ['Write(//**/handoff-commit-msg-*.txt)']
        assert [r for r in rules if file_rule_matches(r, 'Edit', f'{folder}/{msg}')] == []


@pytest.mark.parametrize('tool, path', [
    ('Write', '/etc/passwd'),
    ('Write', '/Users/a/.zshrc'),
    ('Write', '/Users/a/proj/src/app.py'),
    ('Write', '/Users/a/proj/.claude/settings.json'),
    ('Write', '/Users/a/proj/HANDOFF.md'),                 # no underscore: not a handoff name
    ('Write', '/Users/a/proj/HANDOFF_x.txt'),
    ('Write', '/Users/a/proj/handoff_x.md'),
    ('Write', '/Users/a/proj/docs/handoffs/INDEX.md'),     # the script writes INDEX.md, not the model
    ('Write', '/Users/a/proj/handoff-commit-msg-x.md'),
    ('Edit', '/Users/a/proj/docs/handoffs/INDEX.md'),
    ('Edit', '/Users/a/proj/src/app.py'),
    ('Write', 'HANDOFF_x.md'),                             # relative: the skill always uses absolute paths
])
def test_file_rules_do_not_open_anything_else(text, tool, path):
    rules = frontmatter(text)['allowed-tools']
    assert [r for r in rules if file_rule_matches(r, tool, path)] == []


# --- nothing personal; one $ARGUMENTS ---------------------------------------------------------

FORBIDDEN = ['HARNESS', 'Kimi', 'measure-cost', 'MEMORY.md', '~/.claude/skills',   # brief, Step 2 grep
             'Measured over', '94 runs', 'gather.sh', 'nickvels', '**Auto:**',      # brief Step 1; ruling 1
             'Close this session', 'close without commit', 'Close Flow']             # brief: close question removed


@pytest.mark.parametrize('word', FORBIDDEN)
def test_forbidden_words_absent(text, word):
    assert word not in text


def test_arguments_placeholder_appears_once(text):
    # Claude Code replaces EVERY `$ARGUMENTS` in the body with the call's arguments; a second
    # mention would turn into the user's text in the middle of an instruction.
    assert text.count('$ARGUMENTS') == 1


def test_step_references_point_at_existing_steps(text):
    headings = set(re.findall(r'^## Step (\d):', text, re.M))
    assert headings == {'1', '2', '3', '4', '5', '6'}
    assert set(re.findall(r'Step (\d)', text)) <= headings


# --- script commands ---------------------------------------------------------------------------

def command_template(text, script):
    """The documented macOS/Linux command for `script`, split like a shell would."""
    found = [line for block in fences(text, 'bash') for line in block.splitlines()
             if f'/scripts/{script}"' in line]
    assert len(found) == 1, found
    tokens = shlex.split(found[0])
    assert tokens[:2] == ['python3', '-I']   # brief: isolated mode (spec F-09)
    return tokens


def build(tokens, mapping):
    """Documented command -> argv: python3 -> this interpreter, <base> -> the skill folder,
    every placeholder via `mapping` (None drops it; a flag stays itself unless mapped)."""
    argv = [sys.executable, tokens[1], tokens[2].replace('<base>', str(SKILL_DIR))]
    for tok in tokens[3:]:
        if tok not in mapping and tok.startswith('--'):
            mapping = dict(mapping, **{tok: tok})   # a flag is itself, unless the test maps it away
        assert tok in mapping, f'placeholder {tok!r} of the documented command is not handled by the test'
        if mapping[tok] is not None:
            argv.append(mapping[tok])
    return argv


def sh(argv, cwd):
    env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(cwd).parent), **ISOLATED)
    r = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, encoding='utf-8', env=env, timeout=60)
    assert r.returncode == 0, f'{argv}\nSTDERR:\n{r.stderr}\nSTDOUT:\n{r.stdout}'
    return r.stdout


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), '-c', 'core.quotepath=off', *args], capture_output=True,
                          text=True, encoding='utf-8', env=dict(os.environ, **ISOLATED)).stdout


def test_documented_scripts_are_the_scripts_that_exist(text):
    named = set(re.findall(r'"<base>/scripts/(\w+\.py)"', text))
    assert named == {'gather.py', 'index.py', 'commit.py'}
    assert all((SCRIPTS / n).is_file() for n in named)
    # the Windows form and the fallback interpreter are spelled out (brief, Scripts paragraph)
    assert 'py -3 -I "<base>\\scripts\\<name>.py"' in text
    assert '`python -I`' in text


def test_documented_gather_command_runs(text, repo):
    argv = build(command_template(text, 'gather.py'), {'[chain_tag]': 'tt'})
    out = sh(argv, repo)
    assert f'ROOT: {repo.resolve()}' in out.splitlines()
    assert any(l.startswith('HANDOFF_DIR: ') for l in out.splitlines())
    assert any(re.fullmatch(r'FRESH_STANDALONE_TAG: standalone-[0-9a-f]{8}', l) for l in out.splitlines())
    assert "--- chain candidates for 'tt', by seq ascending" not in out   # no handoff folder yet, no section


def make_handoff(repo, lines=5):
    h = repo / '.claude/handoffs'
    h.mkdir(parents=True, exist_ok=True)
    p = h / 'HANDOFF_tt_x_2026-10-08.md'
    p.write_text('line\n' * lines, encoding='utf-8')
    return p


def test_documented_index_command_runs_and_takes_seven_arguments(text, repo):
    tokens = command_template(text, 'index.py')
    assert len(tokens) - 3 == 7   # index.py's own usage: PATH TAG SEQ DATE STATUS TOPIC NEXT
    hp = make_handoff(repo, lines=5)
    out = sh(build(tokens, {'{absolute handoff path}': str(hp), '{chain_tag}': 'tt', '{N}': '1',
                            '{YYYY-MM-DD}': '2026-10-08', '{STATUS}': 'IN PROGRESS',
                            '{topic}': 'тема', '{next action}': 'дальше'}), repo)
    assert 'HANDOFF_LINES: 5' in out.splitlines()
    entries = [l for l in (hp.parent / 'INDEX.md').read_text(encoding='utf-8').splitlines() if l.startswith('- [')]
    assert entries == ['- [tt seq 1 — тема](HANDOFF_tt_x_2026-10-08.md) — 2026-10-08; IN PROGRESS; next: дальше']


def commit_message(text, trailer):
    """The commit-message template of Step 5, filled in."""
    blocks = [b for b in fences(text, '') if b.startswith('session: ')]
    assert len(blocks) == 1
    msg = blocks[0]
    for key, val in {'{slug}': 'x', '{chain_tag}': 'tt', '{N}': '1', '{handoff_filename}': 'HANDOFF_tt_x_2026-10-08.md',
                     '{one-line summary of what this session accomplished}': 'did the thing'}.items():
        msg = msg.replace(key, val)
    msg = re.sub(r'^\{attribution trailer.*\}$', trailer, msg, flags=re.M)
    assert '{' not in msg, msg
    return msg


def prepare_commit(text, repo, trailer='Co-Authored-By: T <t@example.com>'):
    hp = make_handoff(repo)
    (hp.parent / 'INDEX.md').write_text('# Handoff Index\n', encoding='utf-8')
    (repo / 'src').mkdir()
    (repo / 'src/one.py').write_text('1\n', encoding='utf-8')
    (repo / 'docs').mkdir()
    (repo / 'docs/два файла.md').write_text('2\n', encoding='utf-8')
    (repo / 'other.txt').write_text('not this session\n', encoding='utf-8')
    msg = repo.parent / 'msg.txt'
    msg.write_text(commit_message(text, trailer), encoding='utf-8')
    return hp, msg


def test_documented_commit_command_runs_with_files(text, repo):
    hp, msg = prepare_commit(text, repo)
    out = sh(build(command_template(text, 'commit.py'),
                   {'{absolute handoff path}': str(hp), '{message file}': str(msg),
                    '{path1}': 'src/one.py', '{path2}': 'docs/два файла.md', '…': None}), repo)
    lines = out.splitlines()
    assert sum(l.startswith('COMMITTED: ') for l in lines) == 1
    assert 'SKIPPED_UNRELATED: other.txt' in lines
    assert sorted(git(repo, 'show', '--name-only', '--format=', 'HEAD').splitlines()) == [
        '.claude/handoffs/HANDOFF_tt_x_2026-10-08.md', '.claude/handoffs/INDEX.md',
        'docs/два файла.md', 'src/one.py']
    assert git(repo, 'status', '--porcelain').strip() == '?? other.txt'
    # the commit message of the documented template: subject, handoff pointer, chain, trailer
    body = git(repo, 'log', '-1', '--format=%B').rstrip('\n')
    assert body.splitlines() == [
        'session: x [tt]', '', 'did the thing', '', 'Handoff: HANDOFF_tt_x_2026-10-08.md',
        'Chain: tt seq 1', '', 'Co-Authored-By: T <t@example.com>']


def test_commit_message_template_without_a_trailer(text, repo):
    # "leave it out if neither [system reminder nor CLAUDE.md] does": the template still makes a valid commit
    hp, msg = prepare_commit(text, repo, trailer='')
    out = sh(build(command_template(text, 'commit.py'),
                   {'{absolute handoff path}': str(hp), '{message file}': str(msg),
                    '{path1}': 'src/one.py', '{path2}': 'docs/два файла.md', '…': None}), repo)
    assert sum(l.startswith('COMMITTED: ') for l in out.splitlines()) == 1
    body = git(repo, 'log', '-1', '--format=%B').rstrip('\n')
    assert body.splitlines() == ['session: x [tt]', '', 'did the thing', '',
                                 'Handoff: HANDOFF_tt_x_2026-10-08.md', 'Chain: tt seq 1']


def test_documented_commit_command_without_files(text, repo):
    # "if the session touched no other file, leave out --files"
    hp, msg = prepare_commit(text, repo)
    argv = build(command_template(text, 'commit.py'),
                 {'{absolute handoff path}': str(hp), '{message file}': str(msg), '--files': None,
                  '{path1}': None, '{path2}': None, '…': None})
    assert '--files' not in argv
    out = sh(argv, repo)
    assert sum(l.startswith('COMMITTED: ') for l in out.splitlines()) == 1
    assert sorted(git(repo, 'show', '--name-only', '--format=', 'HEAD').splitlines()) == [
        '.claude/handoffs/HANDOFF_tt_x_2026-10-08.md', '.claude/handoffs/INDEX.md']


# --- words shared with the scripts -------------------------------------------------------------

def test_outcome_words_are_exactly_those_commit_py_prints(text):
    printed = set(re.findall(r"print\(f?'((?:COMMIT|SKIPPED_)\w+):", (SCRIPTS / 'commit.py').read_text(encoding='utf-8')))
    assert printed == {'COMMITTED', 'COMMIT_SKIPPED', 'COMMIT_FAILED', 'SKIPPED_SECRET', 'SKIPPED_UNRELATED',
                       'SKIPPED_MISSING', 'SKIPPED_IGNORED'}   # commit.py's docstring lists these seven
    step5 = section(text, '## Step 5: Commit — silently, no question')
    mentioned = set(re.findall(r'`((?:COMMIT|SKIPPED_)\w+):', step5))
    assert mentioned == printed


def test_gather_words_exist_in_gather_py(text):
    gather = (SCRIPTS / 'gather.py').read_text(encoding='utf-8')
    for word in ('NOT_GIT: yes', 'GIT_ERROR: ', 'FRESH_STANDALONE_TAG', 'HANDOFF_DIR', 'ROOT', 'does not exist yet'):
        assert word in text, word
        assert word in gather, word
    assert 'HANDOFF_LINES' in text and 'HANDOFF_LINES' in (SCRIPTS / 'index.py').read_text(encoding='utf-8')


def test_secret_lists_in_the_fallback_are_commit_pys_lists(text):
    commit = load('commit')
    fallback = section(text, '## If Python is missing')
    files = re.search(r'- file names: (.*)', fallback).group(1)
    folders = re.search(r'- folder names \(.*?\): (.*)', fallback).group(1)
    assert re.findall(r'`([^`]+)`', files) == commit.SECRET
    assert re.findall(r'`([^`]+)`', folders) == commit.SECRET_DIR
    # spec F-12 (docs/superpowers/specs/2026-10-08-claude-kit-design.md), typed from the spec: these must
    # never be committed, whatever else commit.py adds
    f12 = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '*credentials*', '*secret*',
           '*.keystore', '*.env', 'id_ecdsa*', 'id_dsa*']
    assert len(f12) == 13
    assert set(f12) <= set(re.findall(r'`([^`]+)`', files))


def test_hand_written_index_line_in_the_fallback_has_the_scripts_format(text, repo):
    # The fallback tells the model to build the line "in the Step 4 format"; Step 4 spells the
    # format out. It must be what index.py really writes (hand-expanded here from Step 4's text).
    step4 = section(text, '## Step 4: Index + count — ONE Bash call')
    fmt = re.search(r'It appends `(- \[.*?)` to', step4).group(1)
    hp = make_handoff(repo)
    sh([sys.executable, '-I', str(SCRIPTS / 'index.py'), str(hp), 'tt', '2', '2026-10-09', 'COMPLETED', 'topic', 'nxt'], repo)
    written = (hp.parent / 'INDEX.md').read_text(encoding='utf-8').splitlines()[-1]
    by_hand = (fmt.replace('{tag}', 'tt').replace('{N}', '2').replace('{topic}', 'topic')
                  .replace('{filename}', hp.name).replace('{date}', '2026-10-09')
                  .replace('{status}', 'COMPLETED').replace('{next}', 'nxt'))
    assert by_hand == written


# --- the default handoff folder in the plain-git fallback (spec F-10, fix round 1) ----------------------

# Source: spec F-10 (docs/superpowers/specs/2026-10-08-claude-kit-design.md), typed from the spec,
# not from gather.py or SKILL.md.
SPEC_F10_DIRS = ['docs/superpowers/handoffs', 'plans/handoffs', 'docs/handoffs', '.claude/handoffs']


def fallback_folder_rule(text):
    """(existing-folder list, folder that needs `docs/superpowers`, that parent, default, default without git)
    as the 'If Python is missing' section states them."""
    step1 = next(l for l in section(text, '## If Python is missing').splitlines() if l.startswith('- **Step 1:**'))
    m = re.search(r'`HANDOFF_DIR` is the first existing folder of (.*?) under the root; none exists → `([^`]+)` '
                  r'if `([^`]+)` exists, otherwise `([^`]+)`; outside git → `([^`]+)` in the current folder', step1)
    assert m, step1
    return re.findall(r'`([^`]+)`', m.group(1)), m.group(2), m.group(3), m.group(4), m.group(5)


def test_fallback_folder_rule_is_spec_f10(text):
    assert fallback_folder_rule(text) == (SPEC_F10_DIRS, 'docs/superpowers/handoffs', 'docs/superpowers',
                                          'docs/handoffs', 'docs/handoffs')


def test_fallback_folder_rule_is_what_gather_py_does(text, tmp_path):
    gather = load('gather')
    dirs, with_sp, sp_parent, default, no_git = fallback_folder_rule(text)
    assert list(gather.HANDOFF_DIR_CANDIDATES) == dirs
    for i, rel in enumerate(dirs):                       # only this folder exists -> it is picked
        root = tmp_path / f'only{i}'
        (root / rel).mkdir(parents=True)
        assert gather.pick_handoff_dir(root, True) == root / rel
    empty = tmp_path / 'empty'; empty.mkdir()
    assert gather.pick_handoff_dir(empty, True) == empty / default
    assert gather.pick_handoff_dir(empty, False) == empty / no_git
    sp = tmp_path / 'sp'; (sp / sp_parent).mkdir(parents=True)
    assert gather.pick_handoff_dir(sp, True) == sp / with_sp
    # a folder created from scratch is never under .claude/ (spec F-10: a write there was refused under
    # acceptEdits in the live run of Task 6, so an unattended handoff would stall)
    assert not any('.claude' in Path(x).parts for x in (with_sp, default, no_git))


# --- the contract with the mod ---------------------------------------------------------------------

def test_template_header_parses_the_way_the_mod_and_gather_read_it(text):
    template = [b for b in fences(text, 'markdown') if b.startswith('# {one-line summary}')]
    assert len(template) == 1
    t = template[0]
    chain_line = next(l for l in t.splitlines() if l.startswith('**Chain:**'))
    rendered = chain_line.replace('{chain_tag}', 'my-tag.2').replace('{N}', '7')
    # parseChain in the plan's Task 7 (mod): /\*\*Chain:\*\*\s*`([^`]+)`\s*seq\s*`?(\d+)/
    m = re.search(r'\*\*Chain:\*\*\s*`([^`]+)`\s*seq\s*`?(\d+)', rendered)
    assert m and m.groups() == ('my-tag.2', '7')
    gather = load('gather')
    field = gather.field([rendered], '**Chain:**')
    assert gather.names_chain(field, 'my-tag.2')
    assert re.search(r'seq `?([0-9]+)', field).group(1) == '7'


def test_template_sections_in_the_original_order_plus_session_closed(text):
    t = [b for b in fences(text, 'markdown') if b.startswith('# {one-line summary}')][0]
    # Order: the user's original skill (spec F-08: "те же разделы хендоффа"); Session Closed last.
    assert re.findall(r'^## (.+?)(?:\s+←.*)?$', t, re.M) == [
        'Since Last Handoff', 'Related Handoffs', 'The Goal', 'Where We Are', 'What We Tried', 'Key Decisions',
        'Evidence & Data', 'Files Changed', 'User Feedback & Preferences', "Where We're Going",
        'Risks & Open Questions', 'Suggested Skills', 'Quick Start', 'Session Closed']
    assert len([l for l in t.splitlines() if l.startswith('**Commit:**')]) == 1   # Step 5 replaces this very line


def test_auto_mode_contract(text):
    auto = section(text, '## Mode switch — decide before Step 1')
    assert 'starts with `auto `' in auto
    assert 'exactly that path' in auto
    assert 'HANDOFF_DONE: <path>' in auto
    assert 'Ask nothing, ever.' in auto
    assert 'Print it only once the file is written' in auto
    assert 'once the file is written' in section(text, '## Step 6: Report, then finish by mode')


def test_no_paste_prompt_or_tip_in_auto_mode(text):
    auto = section(text, '## Mode switch — decide before Step 1')
    assert 'No paste prompt, no tip about opening a session' in auto
    step6 = section(text, '## Step 6: Report, then finish by mode')
    assert step6.index('**Auto mode:**') < step6.index('**Manual mode:**') < step6.index('### Paste prompt (manual mode)')


# Source: brief Task 6 Step 1 = the plan's Task 7 `pastePrompt` (the mod prints the same text).
# The spec (F-14) paraphrases it only, so the wording itself is checked by review, not by the spec.
PASTE_PROMPT = """Прочитай `{absolute path}` (seq {N}, {chain_tag}) и продолжи работу с раздела «Where We're Going».

Прежде чем начинать:
1. Перескажи в 5–8 строках: цель, текущее состояние, что пробовали и что не вышло
2. Прочитай ТОЛЬКО файлы из «Must-read» в Quick Start
3. Скажи, что проверишь первым и каким будет первый шаг
Потом жди моего «поехали».
"""


def test_paste_prompt_is_the_agreed_text(text):
    blocks = [b for b in fences(text, 'text') if b.startswith('Прочитай')]
    assert blocks == [PASTE_PROMPT]
    rendered = blocks[0].replace('{absolute path}', '/r/H.md').replace('{N}', '2').replace('{chain_tag}', 't')
    assert rendered.split('\n')[0] == "Прочитай `/r/H.md` (seq 2, t) и продолжи работу с раздела «Where We're Going»."
    assert rendered.rstrip('\n').split('\n')[-1] == 'Потом жди моего «поехали».'


def test_tip_for_opening_a_new_session(text):
    assert ('"Open a new session (terminal: run `claude` in this folder; app: ⌘N / Ctrl+N) and paste it."'
            in section(text, '### Paste prompt (manual mode)'))


def test_threshold_default_quoted_in_cost_model_is_the_plugins(text):
    default = json.loads(PLUGIN_JSON.read_text(encoding='utf-8'))['userConfig']['threshold']['default']
    assert default == 50
    assert 'around 50% of the context' in section(text, '## Cost Model — why the steps below are shaped this way')


# --- auto mode looks things up in the folder of the target path (live bug 2026-10-11…13) ---------------------------
#
# Source of the expected behaviour: the task brief. The session started in a folder that was not a repository, the
# shell later moved into a nested repository, and gather (run in the shell's folder) found the chain parent there
# instead of in the folder of the file the mod asked for. The text cannot make the model obey; these tests pin what
# can be checked: auto mode's text passes the option, manual mode's text does not, the documented call really works
# against the script, and the permission rule still matches the longer call.

def mode_blocks(text):
    mode = section(text, '## Mode switch — decide before Step 1')
    return mode[mode.index('**AUTO MODE**'):mode.index('**MANUAL MODE**')], mode[mode.index('**MANUAL MODE**'):]


def step1_auto_paragraph(text):
    step1 = section(text, '## Step 1: Gather — ONE Bash call')
    return next(p for p in step1.split('\n\n') if p.startswith('**Auto mode:**'))


def test_auto_mode_passes_handoff_dir_and_manual_mode_does_not(text):
    auto, manual = mode_blocks(text)
    assert '--handoff-dir' in auto
    assert '--handoff-dir' not in manual
    paragraph = step1_auto_paragraph(text)
    assert 'add `--handoff-dir "<folder of the target path>"` to this same call' in paragraph
    assert '--root' not in paragraph
    # the one documented command line (manual mode's) is unchanged: no fenced block carries the option
    assert '--handoff-dir' not in command_template(text, 'gather.py')
    assert not [b for b in fences(text) if '--handoff-dir' in b]
    # Step 1 mentions the option only in that paragraph
    step1 = section(text, '## Step 1: Gather — ONE Bash call')
    assert step1.replace(paragraph, '').count('--handoff-dir') == 0


def test_the_python_missing_fallback_also_uses_the_folder_of_the_target_path_in_auto_mode(text):
    step1 = next(l for l in section(text, '## If Python is missing').splitlines() if l.startswith('- **Step 1:**'))
    assert ('Auto mode: `HANDOFF_DIR` is the folder of the target path, and every git command of this step is run as '
            '`git -C "<that folder>"` (a folder that does not exist yet: its nearest existing parent).') in step1


def documented_handoff_dir_args(text, folder):
    """The option as the auto-mode paragraph writes it, with the placeholder filled in, split like a shell would."""
    m = re.search(r'add `(--handoff-dir "<folder of the target path>")`', step1_auto_paragraph(text))
    assert m
    return shlex.split(m.group(1).replace('<folder of the target path>', str(folder)))


def test_documented_gather_call_with_handoff_dir_reads_the_target_folder_not_the_shell_folder(text, tmp_path, make_repo):
    target = make_repo(tmp_path / 'Мой проект' / 'Общая папка')                  # spaces and Cyrillic in the path
    shell = make_repo(tmp_path / 'nested-repo')                           # where the shell has moved to
    folder = target / 'docs' / 'handoffs'
    folder.mkdir(parents=True)
    (folder / 'HANDOFF_tt_target.md').write_text('**Chain:** `tt` seq `2`\n', encoding='utf-8')
    (shell / 'docs/handoffs').mkdir(parents=True)
    (shell / 'docs/handoffs/HANDOFF_tt_shell.md').write_text('**Chain:** `tt` seq `7`\n', encoding='utf-8')
    argv = build(command_template(text, 'gather.py'), {'[chain_tag]': 'tt'}) + documented_handoff_dir_args(text, folder)
    out = sh(argv, shell).splitlines()
    assert f'ROOT: {target}' in out
    assert f'HANDOFF_DIR: {folder}' in out
    assert [l for l in out if 'tt_shell' in l] == []                              # the shell folder's handoff is not read
    # the target folder's handoff, once in "newest handoffs" (no status line: empty last field), once as the chain candidate
    assert [l for l in out if l.startswith('HANDOFF_tt_')] == ['HANDOFF_tt_target.md | `tt` seq `2` | ', 'HANDOFF_tt_target.md | `tt` seq `2`']


@pytest.mark.parametrize('interp, script, folder', [
    ('python3 -I', f'{POSIX_BASES[0]}/scripts/gather.py', '/Users/anna/proj/docs/handoffs'),
    ('python3 -I', f'{POSIX_BASES[1]}/scripts/gather.py', '/Users/Анна Иванова/Общая папка/docs/handoffs'),
    ('python -I', f'{POSIX_BASES[2]}/scripts/gather.py', '/home/dev/my proj/docs/superpowers/handoffs'),
    ('py -3 -I', f'{WINDOWS_BASE}\\scripts\\gather.py', 'C:\\Users\\Anna\\Общая папка\\docs\\handoffs'),
])
def test_gather_call_with_handoff_dir_is_still_matched_by_exactly_its_own_rule(text, interp, script, folder):
    rules = [r for r in frontmatter(text)['allowed-tools'] if r.startswith('Bash(')]
    # the call as the text writes it: the script and the folder in double quotes, the option after the tag
    cmd = f'{interp} "{script}" tt --handoff-dir "{folder}"'
    assert [r for r in rules if bash_rule_matches(r, cmd)] == [f'Bash({interp} *handoff*gather.py*)']


# --- manual mode looks things up in the folder the session started in (live case 2026-10-15) ----------------------
#
# Source of the expected behaviour: the user's report. The session started in «Мой проект» (not a repository), Claude
# `cd`-ed into a nested repository, a manual handoff landed there while the chain's parent lay in the start folder.
# The mod appends `SESSION_ROOT: <folder>` to the skill's text (register.ts); manual mode hands it to gather as --root.

REGISTER_TS = Path(__file__).parents[1] / 'hooks/register.ts'


def step1_manual_paragraph(text):
    step1 = section(text, '## Step 1: Gather — ONE Bash call')
    return next(p for p in step1.split('\n\n') if p.startswith('**Manual mode:**'))


def test_manual_mode_passes_the_session_root_and_auto_mode_does_not(text):
    auto, manual = mode_blocks(text)
    assert '--root' in manual and '--root' not in auto
    paragraph = step1_manual_paragraph(text)
    assert 'add `--root "<session root>"` to this same call' in paragraph
    assert '`SESSION_ROOT:`' in paragraph
    assert 'primary working directory' in paragraph                               # without the mod
    assert '--root' not in command_template(text, 'gather.py')                      # the fenced command is unchanged
    assert not [b for b in fences(text) if '--root' in b]


def test_the_marker_the_skill_reads_is_the_one_the_mod_writes(text):
    mod = REGISTER_TS.read_text(encoding='utf-8')
    assert re.search(r'`\$\{r\.text\}\\nSESSION_ROOT: \$\{await sessionRoot\(\$\)\}\\n`', mod)
    assert '`SESSION_ROOT:`' in step1_manual_paragraph(text)


def test_the_python_missing_fallback_also_uses_the_session_root_in_manual_mode(text):
    step1 = next(l for l in section(text, '## If Python is missing').splitlines() if l.startswith('- **Step 1:**'))
    assert ('Manual mode: every git command of this step is run as `git -C "<session root>"`, and outside git '
            '`HANDOFF_DIR` is `docs/handoffs` in the session root.') in step1


def documented_root_args(text, folder):
    m = re.search(r'add `(--root "<session root>")`', step1_manual_paragraph(text))
    assert m
    return shlex.split(m.group(1).replace('<session root>', str(folder)))


def test_documented_gather_call_with_root_reads_the_start_folder_not_the_shell_folder(text, tmp_path, make_repo):
    start = tmp_path / 'Мой проект'                                             # not a repository; space in the name
    shell = make_repo(start / 'tender-automation-main-wt')                     # where the shell has moved to
    (start / 'docs/handoffs').mkdir(parents=True)
    (start / 'docs/handoffs/HANDOFF_tt_start.md').write_text('**Chain:** `tt` seq `77`\n', encoding='utf-8')
    (shell / 'docs/superpowers/handoffs').mkdir(parents=True)
    (shell / 'docs/superpowers/handoffs/HANDOFF_tt_shell.md').write_text('**Chain:** `tt` seq `5`\n', encoding='utf-8')
    argv = build(command_template(text, 'gather.py'), {'[chain_tag]': 'tt'}) + documented_root_args(text, start)
    out = sh(argv, shell).splitlines()
    assert f'ROOT: {start}' in out
    assert f'HANDOFF_DIR: {start / "docs" / "handoffs"}' in out
    assert [l for l in out if 'tt_shell' in l] == []
    assert [l for l in out if l.startswith('HANDOFF_tt_')] == ['HANDOFF_tt_start.md | `tt` seq `77` | ', 'HANDOFF_tt_start.md | `tt` seq `77`']


@pytest.mark.parametrize('interp, script, folder', [
    ('python3 -I', f'{POSIX_BASES[0]}/scripts/gather.py', '/Users/anna/Мой проект'),
    ('py -3 -I', f'{WINDOWS_BASE}\\scripts\\gather.py', 'C:\\Users\\Anna\\Общая папка'),
])
def test_gather_call_with_root_is_still_matched_by_exactly_its_own_rule(text, interp, script, folder):
    rules = [r for r in frontmatter(text)['allowed-tools'] if r.startswith('Bash(')]
    cmd = f'{interp} "{script}" tt --root "{folder}"'
    assert [r for r in rules if bash_rule_matches(r, cmd)] == [f'Bash({interp} *handoff*gather.py*)']
