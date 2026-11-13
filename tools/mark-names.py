#!/usr/bin/env python3
"""Decide which names in data/propernouns.txt are also everyday words.

A line written "?Name" is a name that is also an ordinary word - Grace, Will,
Rose, Banks, Reunion - and Caret only asks for its capital when the sentence
clearly uses it as a name ("Dear grace,", "my name is will"). A plain "Name"
is only ever a name - Jason, Sam, Japan - and a lower-case one always gets
the capital suggested.

The rule: a name is also an ordinary word when its lower-case form is a word
in the Hunspell en_US list (with all the forms it allows, so "reunion" counts
even though Hunspell only stores "union" with a re- prefix flag). Except for
the names in ALWAYS_NAME, whose lower-case meaning is so rare or so slangy
that someone writing "john" or "mike" almost certainly means the person.

    python3 tools/mark-names.py      (needs tools/sources/hunspell-expanded.txt)
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMES = os.path.join(ROOT, "data", "propernouns.txt")
HUNSPELL = os.path.join(ROOT, "tools", "sources", "hunspell-expanded.txt")

# Given names (and a few places and adjectives) whose lower-case spelling is
# technically a word, but one nobody writing a school essay or an email means:
# john (slang), mike (microphone), tom (a male cat), jenny (a female donkey).
ALWAYS_NAME = {
    "john", "johnny", "jimmy", "tom", "tommy", "harry", "tony",
    "martin", "maria", "jenny", "rick", "josh", "ted",
    "hank", "molly", "sally", "mike", "charlie",
    "lee", "japan", "christian", "kevin", "steve", "dave", "tim",
    # Places and brands whose lower-case form is only a rare plural of
    # something else (wale, alp, everglade, cheerio, tum).
    "wales", "alps", "everglades", "cheerios", "tums",
}
# Left out on purpose, because they are everyday words too: victor (won),
# peter (out), bobby (pin), billy (goat), joey (a young kangaroo), terry
# (towel). Those stay "?" and are only flagged where the sentence means a name.

# Names already marked as ordinary words on purpose, whatever Hunspell says.
# Everyday words the US word list does not have: "grey" is the British
# spelling of "gray", so it is a word, not only a surname.
KEEP_AMBIGUOUS = {"wi-fi", "wifi", "grey"}


def main():
    if not os.path.exists(HUNSPELL):
        sys.exit(f"missing {HUNSPELL} - see tools/hunspell-expand.py")
    words = set(open(HUNSPELL, encoding="utf8").read().split())
    lines = open(NAMES, encoding="utf8").read().split("\n")
    out = []
    changed = {"to_word": [], "to_name": []}
    for line in lines:
        entry = line.strip()
        if not entry or entry.startswith("#"):
            out.append(line)
            continue
        was_ambiguous = entry.startswith("?")
        name = entry[1:] if was_ambiguous else entry
        lower = name.lower()
        if lower in ALWAYS_NAME:
            ambiguous = False
        elif lower in KEEP_AMBIGUOUS:
            ambiguous = True
        else:
            ambiguous = lower in words and lower != name
        if ambiguous != was_ambiguous:
            changed["to_word" if ambiguous else "to_name"].append(name)
        out.append(("?" if ambiguous else "") + name)
    open(NAMES, "w", encoding="utf8").write("\n".join(out))
    print(f"now also everyday words ({len(changed['to_word'])}):", " ".join(changed["to_word"]))
    print(f"now names only ({len(changed['to_name'])}):", " ".join(changed["to_name"]))


if __name__ == "__main__":
    main()
