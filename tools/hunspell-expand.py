#!/usr/bin/env python3
"""Expand a Hunspell dictionary into every word form it licenses.

The base list the dictionary was built from (dwyl/english-words) is a flat bag
of words with gaps in it - it has "screenshot" but not "screenshots", "emoji"
but not "emojis". Guessing the missing forms with hand-rolled rules produces
things like "aardvarking", because nothing tells you which words are verbs.

Hunspell already knows. Each stem in its .dic carries flags saying which
endings it takes, and the .aff spells out what each flag does, conditions and
all. Applying them gives real inflections and nothing else.

    python3 tools/hunspell-expand.py en.dic en.aff out.txt
"""

import re
import sys


def parse_aff(path):
    """-> {flag: (kind, [(strip, add, condition_regex, crossproduct)])}"""
    rules = {}
    lines = open(path, encoding="utf8").read().split("\n")
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        i += 1
        if len(parts) < 4 or parts[0] not in ("SFX", "PFX"):
            continue
        kind, flag, cross, count = parts[0], parts[1], parts[2] == "Y", int(parts[3])
        entries = []
        for _ in range(count):
            row = lines[i].split()
            i += 1
            if len(row) < 4:
                continue
            strip = "" if row[2] == "0" else row[2]
            add = "" if row[3] == "0" else row[3]
            cond = row[4] if len(row) > 4 else "."
            if cond == ".":
                pattern = re.compile(r".*$" if kind == "SFX" else r"^.*")
            elif kind == "SFX":
                pattern = re.compile(cond + "$")
            else:
                pattern = re.compile("^" + cond)
            entries.append((strip, add, pattern, cross))
        rules[flag] = (kind, entries)
    return rules


def apply_sfx(stem, strip, add, pattern):
    if strip and not stem.endswith(strip):
        return None
    if not pattern.search(stem):
        return None
    return stem[: len(stem) - len(strip)] + add if strip else stem + add


def apply_pfx(stem, strip, add, pattern):
    if strip and not stem.startswith(strip):
        return None
    if not pattern.search(stem):
        return None
    return add + stem[len(strip):]


def main(dic_path, aff_path, out_path):
    rules = parse_aff(aff_path)
    # 's possessives, and the only-in-compound ordinal pieces, are not words the
    # checker should learn here.
    skip_flags = {"M", "c", "!"}

    out = set()
    lines = open(dic_path, encoding="utf8").read().split("\n")
    for line in lines[1:]:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        stem, _, flags = line.partition("/")
        stem = stem.strip()
        if not stem:
            continue
        out.add(stem)

        flags = [f for f in flags.strip() if f not in skip_flags]
        suffixed = []
        for flag in flags:
            if flag not in rules:
                continue
            kind, entries = rules[flag]
            if kind != "SFX":
                continue
            for strip, add, pattern, cross in entries:
                form = apply_sfx(stem, strip, add, pattern)
                if form:
                    out.add(form)
                    if cross:
                        suffixed.append(form)

        for flag in flags:
            if flag not in rules:
                continue
            kind, entries = rules[flag]
            if kind != "PFX":
                continue
            for strip, add, pattern, cross in entries:
                form = apply_pfx(stem, strip, add, pattern)
                if form:
                    out.add(form)
                # un- + -ing, re- + -ed: only where both rules allow it.
                if cross:
                    for base in suffixed:
                        form = apply_pfx(base, strip, add, pattern)
                        if form:
                            out.add(form)

    words = sorted(w for w in out if w)
    with open(out_path, "w", encoding="utf8") as f:
        f.write("\n".join(words) + "\n")
    print(f"{len(lines) - 1} stems -> {len(words)} forms, written to {out_path}")


main(*sys.argv[1:4])
