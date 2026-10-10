#!/usr/bin/env python3
"""Append one handoff line to INDEX.md (<=200 chars) and print the handoff's line count.

Usage: python3 -I index.py HANDOFF_PATH CHAIN_TAG SEQ DATE STATUS "TOPIC" "NEXT"
       (Windows: py -3 -I index.py ...)

Why a script: the model can't count characters reliably (Cyrillic especially), so a
hand-built line overshoots the limit and costs an extra fix turn. The script fits the
line by construction and never reads INDEX.md into the conversation.
The 200-char limit holds as long as the line without TOPIC and NEXT (tag, seq, date,
status, file name and the fixed punctuation) is at most 180 chars; beyond that TOPIC
and NEXT get a 20-char room and the line goes over the limit.
"""
import os
import sys

LIMIT = 200


def clip(s, n):
    s = " ".join(s.split())
    return s if len(s) <= n else s[: max(n - 1, 0)].rstrip() + "…"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 8:
        sys.exit(__doc__)
    path, tag, seq, date, status, topic, nxt = sys.argv[1:]
    if not os.path.isfile(path):
        sys.exit(f"ERROR: handoff file not found: {path}")
    name = os.path.basename(path)
    index = os.path.join(os.path.dirname(path), "INDEX.md")

    def build(t, x):
        return f"- [{tag} seq {seq} — {t}]({name}) — {date}; {status}; next: {x}"

    fixed = len(build("", ""))
    room = max(LIMIT - fixed, 20)
    t_len = min(len(topic), max(room // 2, room - len(nxt)))
    line = build(clip(topic, t_len), clip(nxt, room - len(clip(topic, t_len))))

    new = not os.path.exists(index)
    with open(index, "a", encoding="utf-8") as f:
        if new:
            f.write("# Handoff Index\n\n")
        f.write(line + "\n")

    with open(path, encoding="utf-8") as f:
        lines = sum(1 for _ in f)
    print(f"INDEX: {'created ' if new else ''}{index}")
    print(f"APPENDED ({len(line)} chars): {line}")
    print(f"HANDOFF_LINES: {lines}")


if __name__ == "__main__":
    main()
