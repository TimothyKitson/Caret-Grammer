# Caret

A grammar and spelling checker for Microsoft Edge. It underlines mistakes as
you type in any text box on any site, and fixes them from a hover card.

Published: [Caret on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/caret/ejkpanfkmjkkolgdpampfljaangollpm)

## What it does

- **Underlines as you type**, in `<input>`, `<textarea>` and contenteditable
  editors — Gmail, Outlook, Docs-style boxes, forum replies, all of it.
- **Hover to fix.** A card shows what is wrong and what to put instead. Nothing
  changes until you click.
- **Autocorrect**, off by default. Fixes only the mistakes with exactly one
  right answer: `i` → `I`, `dont` → `don't`, sentence capitals, documented
  typos. Ctrl+Z undoes any of them, and a word you undo is left alone after
  that.
- **AI proofreading**, off by default, for the sentence-level things a rule
  cannot see. Works with Google Gemini, OpenAI or Anthropic — see below.

Everything but the AI pass runs offline. Nothing is sent anywhere unless you
switch the AI on.

## Working on it

```sh
npm run lint        # eslint over src and test
npm test            # 121 unit tests
npm run quality     # the accuracy scoreboard - false alarms and misses
npm run test:e2e    # loads the real extension into Chromium and drives it
npm run zip         # builds ../caret-store.zip for the Edge dashboard
```

`npm run test:e2e` needs Playwright and takes a couple of minutes; it types
into real fields in a real browser.

### The accuracy scoreboard

`test/quality.mjs` is the one to watch. It runs the engine over a page of
correct writing and counts what got underlined (**false alarms**), then over a
list of real mistakes and counts what it walked past (**misses**). A checker
that underlines correct writing is worse than no checker, so false alarms are
the number that matters. Both should read 0.

### Loading your build

`edge://extensions` → Developer mode → **Load unpacked** → this folder.

### Publishing

Bump `version` in `manifest.json` (the store rejects a re-upload at the same
version), `npm run zip`, then upload `../caret-store.zip` at
[Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).

Two things the store rejects, both learned the hard way:

- **Any compressed file inside the package.** The word lists are plain text for
  this reason; `tools/build-data.py` must never go back to writing `.gz`.
- **A `description` over 132 characters** in the manifest.

## The AI pass and API keys

Caret works out which provider a key belongs to from the key itself, so there
is no provider setting:

| Provider | Key starts | Cost |
|---|---|---|
| Google Gemini | `AIza` | **Free tier** — no card, capped per minute and per day |
| OpenAI | `sk-` | Pay as you go, credits must be bought up front |
| Anthropic | `sk-ant-` | Pay as you go |

A key pasted into the options page is kept in that browser profile and sent
only to its own provider. To skip the key box entirely and have the settings
page show just a switch, put a key in `src/shared/apikey.js` — read the comment
at the top of that file first, because a baked-in key is readable by anyone who
installs the build.

The model is told, in the system prompt, to keep your vocabulary plain: it may
only change a word that is actually wrong, never one that could sound fancier.
It is also never allowed to rewrite a sentence — at most a few words — and
nothing it suggests is applied until you click it.

## Layout

```
manifest.json
data/            word list, frequency ranking, proper nouns, known typos
src/engine/      the checker: tokenizer, dictionary, spelling, rules, ai
src/content/     what runs in the page: adapters, overlay, controller, autocorrect
src/background/  the service worker - owns settings, the dictionary, API calls
src/options/     the settings page
src/popup/       the toolbar button
test/            unit tests, the quality scoreboard, and browser end-to-end runs
tools/           data builders - only needed if you rebuild the word lists
```

One warning for anyone editing `src/background/`: **no top-level `await`** in
the service worker. It loads, dies silently, and every content script then sits
there waiting for an answer that never comes.

## The shared Worker (optional, in progress)

`worker/` is a Cloudflare Worker that runs the AI pass on one account so a
small group can use it without anybody getting their own API key. It is not
deployed yet — `worker/README.md` has the steps, and `CARET_ENDPOINT` in
`src/shared/apikey.js` stays empty until there is a URL to put in it.
