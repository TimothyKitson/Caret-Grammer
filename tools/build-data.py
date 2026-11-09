#!/usr/bin/env python3
"""Build the language data files the extension ships with.

Reads three source lists from tools/sources/ (downloading them if missing) and
writes three files into data/:

    words.txt           one lowercase word per line, sorted  -> the dictionary
    frequency.txt       most-common words first, one per line -> ranks suggestions
    misspellings.json   {"recieve": ["receive"], ...}         -> high-confidence fixes

Run it again only if you want to rebuild them:  python3 tools/build-data.py
The generated files are committed, so a normal install does not need this script.

Sources (all freely redistributable):
  words_alpha.txt   dwyl/english-words (Unlicense) - 370k English words
  en_50k.txt        hermitdave/FrequencyWords (MIT) - OpenSubtitles 2018 counts
  wikipedia-misspellings.txt
                    en.wikipedia.org/wiki/Wikipedia:Lists_of_common_misspellings
                    /For_machines (CC BY-SA 4.0)
"""

import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "sources")
OUT = os.path.join(ROOT, "data")

SOURCES = {
    "words_alpha.txt": "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt",
    "en_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
    "wikipedia-misspellings.txt": "https://en.wikipedia.org/wiki/Wikipedia:Lists_of_common_misspellings/For_machines?action=raw",
}

# Words the big list is missing or that must never be flagged. Kept here rather
# than in the generated file so a rebuild does not lose them.
EXTRA_WORDS = """
a i ok okay yeah yep nope hey hi hello thanks
email emails emailed website websites webpage webpages webmaster online offline
login logins logout signup signin username usernames password passwords
smartphone smartphones laptop laptops desktop desktops app apps
wifi wi-fi internet intranet blog blogs blogger blogging blogged podcast podcasts
download downloads downloaded uploading uploaded upload uploads
javascript json html css url urls http https api apis sql
github gitlab google googled youtube facebook instagram twitter linkedin tiktok
zoom netflix spotify amazon microsoft windows edge chrome firefox safari android
iphone ipad ios macos linux ubuntu chromebook chromebooks
pdf pdfs docx xlsx pptx jpeg jpg png gif svg mp3 mp4 usb wifi's
teleconference videoconference livestream livestreamed webinar webinars
covid coronavirus vaccinated unvaccinated telehealth
preschool prekindergarten pre-k kindergarten kindergartner kindergartners
homeroom homeschool homeschooled homeschooling schoolwork coursework
gradebook worksheets worksheet fundraiser fundraisers fundraising
extracurricular extracurriculars valedictorian salutatorian
principal's teacher's students' parents' children's school's
pto ptos pta gpa iep ieps stem steam esl
signup carpool carpools carline dropoff pickup
englewood christian jesus christ bible biblical scripture chapel
january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
america american americans canada canadian mexico england english britain british
europe european africa african asia asian australia australian
california florida texas colorado georgia carolina virginia jersey york
tennessee michigan illinois ohio arizona nevada oregon washington
denver chicago boston seattle atlanta dallas houston phoenix philadelphia
mr mrs ms dr jr sr prof rev
gmail outlook hotmail yahoo icloud
timothy kitson
"""

# Contractions, with the possessive/plural forms a plain word list never carries.
CONTRACTIONS = """
i'm i've i'll i'd you're you've you'll you'd he's he'll he'd she's she'll she'd
it's it'll we're we've we'll we'd they're they've they'll they'd
that's that'll there's there'll here's what's what're who's who'll where's
when's why's how's how'd let's
isn't aren't wasn't weren't hasn't haven't hadn't doesn't don't didn't
won't wouldn't can't couldn't shouldn't mustn't mightn't shan't needn't
ain't y'all o'clock ma'am
"""

# Wikipedia entries whose "misspelling" reads as an ordinary word often enough
# that flagging it would be noise.
MISSPELLING_DENYLIST = {
    "wich", "ect", "dum", "gae", "gya", "hass", "bult", "tho", "thru", "ov",
    "als", "ans", "arent", "cant", "dont", "hes", "im", "isnt", "ive", "shes",
    "thats", "theres", "wasnt", "wont", "youre", "youve", "lets", "its", "ill",
    "id", "were", "wed", "well", "hell", "shell", "cause", "til", "till",
    "ther", "nite", "lite", "thier's",
    # real words the Wikipedia list treats as typos - flagging them is noise
    "complier", "causalities", "ceratin", "aircrafts", "commandoes", "quitted",
    "momento", "toke", "agin", "altho", "algebraical", "atheistical",
    "binominal", "vermillion", "cattleship", "arised", "beng",
}

# Kept even if they are common in the frequency list.
MISSPELLING_ALLOWLIST = {
    "alot", "seperate", "seperated", "seperately", "occured", "occuring",
    "untill", "tommorow", "tommorrow", "recieve", "recieved", "definately",
    "thier", "becuase", "teh", "adn", "wierd", "greatful", "wich's",
}

FREQ_DROP_RANK = 6000  # a "misspelling" this common in real text is not one


def fetch(name):
    path = os.path.join(SRC, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(SRC, exist_ok=True)
    url = SOURCES[name]
    print(f"downloading {name} <- {url}")
    with urllib.request.urlopen(url, timeout=180) as r, open(path, "wb") as f:
        f.write(r.read())
    return path


def read_frequency():
    """[(word, count)] in descending count order, apostrophe fragments dropped."""
    out = []
    with open(fetch("en_50k.txt"), encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) != 2:
                continue
            word, count = parts[0].strip().lower(), int(parts[1])
            if word.startswith("'") or not re.fullmatch(r"[a-z'-]+", word):
                continue
            out.append((word, count))
    return out


def read_base_words():
    words = set()
    with open(fetch("words_alpha.txt"), encoding="utf-8") as f:
        for line in f:
            w = line.strip().lower()
            if not w or not re.fullmatch(r"[a-z]+", w):
                continue
            if len(w) == 1 and w not in ("a", "i"):
                continue
            words.add(w)
    return words


def read_misspellings(rank):
    pairs = {}
    skipped_common = skipped_denied = 0
    with open(fetch("wikipedia-misspellings.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "->" not in line or line.startswith(("=", "<", "*", "#", ":")):
                continue
            bad, _, good = line.partition("->")
            bad = bad.strip().lower()
            if not re.fullmatch(r"[a-z']{3,}", bad):
                continue
            fixes = []
            for candidate in good.split(","):
                candidate = candidate.strip()
                if candidate and candidate.lower() != bad:
                    fixes.append(candidate)
            if not fixes:
                continue
            if bad in MISSPELLING_DENYLIST:
                skipped_denied += 1
                continue
            if bad not in MISSPELLING_ALLOWLIST and rank.get(bad, 10 ** 9) <= FREQ_DROP_RANK:
                skipped_common += 1
                continue
            pairs[bad] = fixes[:3]
    print(f"misspellings: kept {len(pairs)}, dropped {skipped_common} too-common, "
          f"{skipped_denied} denylisted")
    return dict(sorted(pairs.items()))


def tokens(blob):
    return [w for w in blob.split() if w]


def main():
    os.makedirs(OUT, exist_ok=True)
    freq = read_frequency()
    rank = {w: i + 1 for i, (w, _) in enumerate(freq)}

    words = read_base_words()
    base_count = len(words)
    words.update(tokens(EXTRA_WORDS))
    words.update(tokens(CONTRACTIONS))
    # Frequent real-world words the academic list omits (min count filters noise).
    words.update(w for w, c in freq if c >= 800 and re.fullmatch(r"[a-z]+", w))
    # Possessives of every base word are accepted by the tokenizer, not stored.

    misspellings = read_misspellings(rank)
    # A word we deliberately flag must not also be "correct".
    words.difference_update(misspellings)

    known = words
    # Contractions carry no count in the subtitle corpus (it splits them into
    # "don" + "'t"), so they would always lose to look-alikes like "done".
    # Seed them at the top of the ranking in rough order of everyday use.
    seeded = tokens("""
    i'm it's don't that's you're i'll can't didn't i've we're they're he's
    she's there's what's let's doesn't isn't won't wouldn't couldn't shouldn't
    haven't hasn't hadn't wasn't weren't aren't i'd you'll you've you'd we'll
    we've we'd they'll they've they'd he'll he'd she'll she'd it'll who's
    here's that'll where's when's how's ain't y'all o'clock ma'am
    """)
    freq_words = seeded + [w for w, _ in freq if (w in known or "'" in w) and w not in set(seeded)]
    freq_words = freq_words[:40000]
    words = sorted(words)

    def write_list(name, lines):
        # Plain text, not gzip: the Edge store rejects a package that contains
        # compressed files, and the service worker reads these with fetch().
        path = os.path.join(OUT, name)
        with open(path, "w", encoding="utf8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"wrote {name} ({len(lines)} lines)")

    write_list("words.txt", words)
    write_list("frequency.txt", freq_words)

    path = os.path.join(OUT, "misspellings.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(misspellings, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write("\n")
    print(f"misspellings.json: {len(misspellings)} entries, "
          f"{os.path.getsize(path)/1e3:.0f} kB")
    print(f"dictionary: {base_count} from words_alpha -> {len(words)} total")


if __name__ == "__main__":
    sys.exit(main())
