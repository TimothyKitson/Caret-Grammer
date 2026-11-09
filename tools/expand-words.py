#!/usr/bin/env python3
"""Grow data/words.txt without pulling in junk.

Two passes:

1. INFLECTIONS. The base list (dwyl/english-words) is missing regular forms of
   words it already has - it knows "screenshot" but not "screenshots", "emoji"
   but not "emojis". Those gaps are false alarms on perfectly ordinary writing.
   A form is only added when the base word is itself known AND common enough to
   appear in the frequency list, so nothing is generated from obscure entries.
   Verb endings are only added when the word is already attested as a verb -
   that is, the list already has one of its other verb forms.

2. A HAND LIST. Vocabulary that postdates the base list, or that a school
   office types every week. Kept in tools/sources/extra-words.txt.

    python3 tools/expand-words.py           # report what it would add
    python3 tools/expand-words.py --write   # write data/words.txt
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORDS = os.path.join(ROOT, "data", "words.txt")
FREQ = os.path.join(ROOT, "data", "frequency.txt")
EXTRA = os.path.join(HERE, "sources", "extra-words.txt")

VOWELS = set("aeiou")
# Too short, or a function word: adding endings to these makes noise, not words.
SKIP = {
    "a", "an", "the", "of", "to", "in", "is", "it", "as", "at", "be", "by", "or",
    "on", "if", "so", "no", "up", "my", "me", "we", "he", "do", "go", "us", "am",
    "and", "but", "for", "nor", "yet", "its", "his", "her", "our", "who", "whom",
    "this", "that", "these", "those", "there", "here", "then", "than", "thus",
    "very", "much", "more", "most", "less", "least", "some", "any", "each",
}


def plural(word):
    if word.endswith(("s", "x", "z", "ch", "sh")):
        return word + "es"
    if word.endswith("y") and len(word) > 2 and word[-2] not in VOWELS:
        return word[:-1] + "ies"
    if word.endswith("f") and len(word) > 3:
        return None          # leaf/leaves, roof/roofs - not worth guessing
    return word + "s"


def ing(word):
    if word.endswith("ie"):
        return word[:-2] + "ying"
    if word.endswith("e") and not word.endswith(("ee", "oe", "ye")):
        return word[:-1] + "ing"
    return word + "ing"


def ed(word):
    if word.endswith("e"):
        return word + "d"
    if word.endswith("y") and len(word) > 2 and word[-2] not in VOWELS:
        return word[:-1] + "ied"
    return word + "ed"


def main():
    words = set(l.strip() for l in open(WORDS, encoding="utf8") if l.strip())
    ranked = set()
    for line in open(FREQ, encoding="utf8"):
        parts = line.split()
        if parts:
            ranked.add(parts[0])

    added = {}

    # ---- pass 1: regular inflections of common words --------------------
    for word in sorted(words & ranked):
        if len(word) < 3 or word in SKIP or not word.isalpha():
            continue

        p = plural(word)
        if p and p not in words:
            added.setdefault(p, "plural of " + word)

        # Only treat it as a verb if the list already agrees that it is one.
        verbal = ing(word) in words or ed(word) in words or (word + "s") in words
        if verbal:
            for form in (ing(word), ed(word)):
                if form not in words:
                    added.setdefault(form, "verb form of " + word)

    # ---- pass 2: the hand list ------------------------------------------
    hand = []
    if os.path.exists(EXTRA):
        for line in open(EXTRA, encoding="utf8"):
            line = line.split("#")[0].strip().lower()
            for word in line.split():
                if word and word not in words:
                    hand.append(word)
                    added.setdefault(word, "hand list")

    by_reason = {}
    for word, reason in added.items():
        key = reason.split(" of ")[0]
        by_reason[key] = by_reason.get(key, 0) + 1

    print(f"words.txt has {len(words)} entries")
    for reason, n in sorted(by_reason.items(), key=lambda kv: -kv[1]):
        print(f"  +{n:>6}  {reason}")
    print(f"  = {len(words) + len(added)} after")

    sample = [w for w in added if added[w].startswith("plural")][:12]
    print("\n  plurals:", " ".join(sample))
    sample = [w for w in added if added[w].startswith("verb")][:12]
    print("  verb forms:", " ".join(sample))
    if hand:
        print("  hand list:", " ".join(sorted(hand)[:16]), "...")

    if "--write" in sys.argv:
        out = sorted(words | set(added))
        with open(WORDS, "w", encoding="utf8") as f:
            f.write("\n".join(out) + "\n")
        print(f"\nwrote {WORDS} ({len(out)} entries)")


main()
