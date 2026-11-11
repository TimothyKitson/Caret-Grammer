# The Caret Worker

A free AI proofreading pass for a small, known group of people — you, your dad,
and about ten others. One Cloudflare account runs the model; everybody else
pastes a short `caret_…` key and never touches an API console.

**This is not a service.** Workers AI's free plan gives the whole account
**10,000 neurons a day**, reset at 00:00 UTC, and when they are gone every
request fails until the reset. They fail; they are never billed. It does two
kinds of check, and they cost very different amounts of that:

| | model | neurons each | on its own, that is |
|---|---|---|---|
| **full check** — the whole field | Llama 3.3 70B | 30–60 for a paragraph, about 110 for an essay-length field (3,000 characters), 240 at most | ~90 essay-length checks a day |
| **quick check** — one finished sentence | IBM Granite 4.0 micro | about 1, 3 at most (about 3, up to 10, if it falls back to Gemma) | thousands a day |

The 70B charges about eight times as much for each token it writes as for each
one it reads, and its system prompt alone is about 630 tokens, so a full check
is never cheap. A hundred essay-length full checks is more than the whole day.
That is why full checks have a share of the day to themselves — 6,000 neurons
by default, for everybody together — and the rest is left for quick checks.
See [Staying on the free plan](#staying-on-the-free-plan) for how that works
and the numbers to set.

Nobody pays for any of it. Not you — everything here is on Cloudflare's free
plan and needs no card — and not the people you give a key to.

## What you do

### 1. Make the account

[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — email and
password, confirm it.

Then click **Compute (Workers)** in the sidebar. It asks you to choose a
subdomain the first time. Whatever you pick becomes part of your public URL,
and changing it later is awkward, so choose one you like.

### 2. Deploy it

**If you do not have Node installed, use this way.** No tooling at all:

1. **Compute** → **Workers** → **Create** → **Start from Hello World** → Deploy.
   Name it `caret-ai`. It asks for a workers.dev subdomain here if you have not
   picked one.
2. Open the Worker → **Edit code**. Delete what is there, paste the whole of
   [`dist/worker.js`](dist/worker.js), and Deploy.
3. Open the Worker → **Settings** → **Bindings**, and add two:
   - **Workers AI**, variable name `AI`
   - **KV namespace**, variable name `KEYS` — click *Create* to make a new
     namespace if you have none; call it `CARET_KEYS`
4. Variables are optional — leave them all out and you get the defaults
   described under [Settings](#settings).
5. Deploy again so the bindings take effect.

Then make keys from **Storage & databases** → **KV** → your namespace → **Add
entry**: key `key:caret_` plus a dozen random characters, value
`{"name":"Everyone","daily":50}`.

---

**With Node**, from this folder:

```sh
npx wrangler login                              # opens a browser, approve once
npx wrangler kv namespace create CARET_KEYS     # prints an id
```

Put that id into `wrangler.toml` where it says `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
Look at its `[vars]` while you are there: `MODEL` should be empty or one of the
models under [Models](#models) — a retired one costs every full check a wasted
call. Then:

```sh
npx wrangler deploy
```

It prints the URL — `https://caret-ai.<your-subdomain>.workers.dev`. Open
`/health` on it in a browser and you should see something like

```json
{"ok":true,"model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast","fallbacks":4,
 "quickModel":"@cf/ibm-granite/granite-4.0-h-micro","quickFallbacks":2}
```

### 3. Make a key for each person

A key is any string starting `caret_`. Make them unguessable, not memorable:

```sh
npx wrangler kv key put --binding=KEYS "key:caret_$(openssl rand -hex 12)" \
  '{"name":"Dad","daily":20}' --remote
```

20 is what Caret allows one person anyway. On the key that everybody's copy
shares, use 50 (see [Staying on the free plan](#staying-on-the-free-plan)).

What a key's record can say:

| field | meaning |
|---|---|
| `name` | only so you can tell them apart in the KV list |
| `daily` | full checks a day on this key. `0` or missing = not capped here (the extension still caps each person at 20, and the full-check share caps everybody) |
| `quickDaily` | quick checks a day on this key. `0` or missing = `QUICK_DAILY`, or 2,000 |
| `revoked` | `true` turns the key off, for both kinds of check |

### 4. Tell me the URL

Paste the `https://caret-ai.….workers.dev` URL into the chat and I will set
`CARET_ENDPOINT` in `src/shared/apikey.js`, rebuild the package, and send you a
version to upload. The URL is not a secret. Neither, in the end, is a key
that is built into the extension — see [Who can call it](#who-can-call-it) for
what that means and what limits it.

## Updating it

The dashboard runs whatever was last pasted into it. After any change to
`worker/src/index.js` or `src/shared/proofread.js`:

```sh
python3 tools/bundle-worker.py      # rewrites dist/worker.js
```

then open the Worker → **Edit code**, replace everything with the new
[`dist/worker.js`](dist/worker.js), and Deploy. Until you do, the old code is
still what answers — including, after this change, a Worker that does not know
what a quick check is and treats every sentence as a full check on the 70B.
Re-paste before giving anyone a build with the quick check in it.

### After pasting this version

1. That is all that is required — the full checks' daily share is on by
   itself, at 6,000 neurons, and it is what keeps room for the quick check.
2. Optional: set `"daily"` on the shared key to about **50** (**Storage &
   databases** → **KV** → `CARET_KEYS` → the `key:caret_…` entry everybody's
   copy of Caret uses → `{"name":"Everyone","daily":50}`, keeping any other
   fields → Save). 100 works too; the meter stops full checks first on a
   heavy day either way.

If you want to change anything else, these are all optional, plain text
variables under the Worker's **Settings** → **Variables and Secrets**:
`FULL_NEURONS_DAILY`, `QUICK_MODEL`, `QUICK_DAILY`, `MODEL`, `PER_KEY_DAILY`.
[Settings](#settings) says what each one does.

## The quick check

The extension can send each sentence to the Worker as the person finishes it.
That request carries `"mode": "quick"` and gets a different, much cheaper
treatment:

- **Its own models.** IBM Granite 4.0 micro first, then Gemma 4 26B, which it
  falls back to by itself if Granite stops answering — at three to five times
  the neurons. Never the 70B, not even as a last resort: at a couple of
  thousand sentences a day, quietly falling back to a model twenty times the
  price would empty the account.
- **Its own prompt.** `QUICK_SYSTEM_PROMPT` in `src/shared/proofread.js` — the
  full check's rules cut down to under 900 characters, because it is paid for
  on every sentence. Same JSON answer, so the extension handles it the same way.
- **One sentence.** The text is cut at 800 characters and the answer at 256
  tokens. Only the person's leave-alone words that actually appear in the
  sentence go into the prompt.
- **Its own count.** Kept apart from the full check's, so a day of typing never
  uses up anybody's full checks, and the other way round. Quick checks are not
  on the full checks' meter either: when the full checks' share runs out, quick
  checks carry on.

Anything without `"mode": "quick"` — including every copy of Caret from before
this existed — is the full check, exactly as it always was.

### How quick checks are counted

KV's free plan allows **1,000 writes a day** for the whole account, and the
quick check runs on every sentence. Writing the counter every time would need
twice the day's writes at the default cap alone, and once they ran out no
counter would move at all — the full check's included.

So quick checks are counted *by chance*: each one draws a random number, and
about one in ten writes the counter, adding ten. On average that is still one
per check, so the count is honest over a day, for a tenth of the writes. It
wanders a little — after 2,000 checks it is usually within about 130 of the
truth — which is fine for a cap whose only job is to stop one key spending
everybody's day. The `left` the Worker reports for a quick check is an estimate
for the same reason.

If KV cannot be read or written, the check goes ahead uncounted rather than
failing — both kinds, and the full checks' meter too. Only a key that cannot
be looked up at all is refused (503), since then nobody knows whether it is a
real one.

## Settings

All optional. Set them as **plain text variables** in the Worker's Settings, or
under `[vars]` in `wrangler.toml`.

| variable | default | what it does |
|---|---|---|
| `FULL_NEURONS_DAILY` | `6000` | neurons a day full checks may use between them, every key together. Past it, full checks get a 429 until midnight UTC; quick checks carry on. `0` = the default |
| `QUICK_MODEL` | *(empty)* | forces a model to the front of the quick check's list |
| `QUICK_DAILY` | `2000` | quick checks a day for a key with no `quickDaily` of its own. `0` = the default, not "no cap" |
| `MODEL` | *(empty)* | forces a model to the front of the full check's list |
| `PER_KEY_DAILY` | `0` | full checks a day for a key with no `daily` of its own. `0` = not capped here |

## Staying on the free plan

The whole account gets 10,000 neurons a day. The Worker splits them like this:

| | what holds it | neurons each | a full day |
|---|---|---|---|
| full checks | `FULL_NEURONS_DAILY`, 6,000 by default, for every key together | ~110 essay-length, 240 at most | ~6,000: about 50 essay-length checks |
| quick checks | each person's own 30–80; `QUICK_DAILY` 2,000 per key as a backstop | ~1, 3 at most | the ~4,000 left: over 1,000 sentences even at the most each can cost |
| **total** | | | **~10,000, and usually well under** |

**The full checks' meter.** The Worker keeps one running total for the whole
account, `neurons:full:<date>` in KV: roughly what full checks have cost since
midnight UTC. Before each full check it looks at the total, and once that has
reached `FULL_NEURONS_DAILY` every full check gets a 429 — *"The full AI checks
for today are used up for everyone. The quick check and the built-in checks
still work. They come back at midnight UTC."* — and Caret treats that as a
pause, not an error. After each full check it adds what the check cost: the
token counts Workers AI reports, at that model's price, or, if it reports none,
four characters to a token. A check that is let in near the line can take the
total a little past it, by one check's worth at most when they come one at a
time.

- **Set `"daily"` on the shared key to about 50.** That is roughly what the
  meter's 6,000 buys in essay-length checks, so neither runs out long before
  the other. With the meter in place it is a backstop for that one key, not the
  thing that keeps you on the free plan.
- **Quick checks fall back to Gemma by themselves** if Granite stops answering,
  and then each costs about 3 neurons, up to 10. If you set `QUICK_MODEL` to
  Gemma on purpose, bring `QUICK_DAILY` down to about 500.
- **The quick backstop is generous.** 2,000 quick checks on Granite is usually
  under 2,000 neurons, but if every one were a long sentence whose answer ran
  to the cap it would be about 6,000 — more than the 4,000 left. Real use comes
  nowhere near it (see below). If you want even that worst case to fit, set
  `QUICK_DAILY` to 1,200.
- Never point `QUICK_MODEL` at the 70B. It would work, at about 10 neurons a
  sentence and over 60 at worst, and the default 2,000 would cost at least
  twice the day's allowance.
- KV stays well inside its free plan too. A full check reads KV four times (the
  key, its count, and the meter before and after) and writes twice (its count
  and the meter); a quick check reads twice and writes one time in ten. About 50
  full checks and 2,000 quick ones is ~300 writes, of 1,000, and ~4,200 reads,
  of 100,000.

**What one person can use, and what that means for the group.** Each copy of
Caret caps its own person at 20 full checks a day, and 30 quick ones unless
they raise it, never past 80. Those are much looser than the shared limits. At
20 full checks each, the day's share — about 50 essay-length full checks for
everybody — covers **two or three people** using every full check they have,
not ten. If more people than that lean on the full check on the same day,
whoever comes after them gets the "used up for everyone" message until
midnight UTC; their quick checks and Caret's built-in checks carry on. Quick
checks are the easy part: a dozen people each at the most they can set, 80, is
under 1,000 sentences, about 1,000 neurons on Granite and 3,000 at the very
most, inside the ~4,000 left.

When the account's allowance does run out anyway, every request gets a 429
with `"spent": true` until midnight UTC, and Caret goes quiet rather than
showing an error. The built-in checks carry on as normal.

## Who can call it

The shared key is built into the extension, so anyone who unpacks it can read
the key and call the Worker from a script. Nothing here can stop that. The caps
are what limit it, and you should know how far:

- **No web page can call it from someone's browser.** The Worker sends no CORS
  headers, so a browser will not hand a page the answer, and a preflight gets a
  204 that allows nothing. Caret itself is not affected: its service worker and
  settings page have permission for every site and are not held to CORS.
- **The caps are approximate when requests arrive at the same moment.** Every
  count here — the meter and both per-key counts — is read from KV, compared
  and written back, and KV has no locks. Requests that land together all read
  the same number, all go ahead, and are added to the total as if they were
  about one. One at a time, the meter is close to exact. In a test, a script
  sending five full checks at once, over and over, spent about 9,600 neurons
  before the meter stopped it, against a share of 6,000, and twenty at once
  went through the whole day. Making the counts exact would need a Durable
  Object, which cannot be set up by pasting one file into the dashboard, so
  this Worker does not use one.
- **The worst case is still free.** Past the meter, the account's own 10,000
  neurons is the ceiling: when they are gone Workers AI refuses, and on the
  free plan it never bills. The worst anyone can do is use the day up early,
  so the AI checks go quiet for everybody until midnight UTC. KV is the same:
  a script hammering the Worker could use up the day's 100,000 reads, and then
  keys cannot be checked (a 503) until midnight. Neither costs you anything.
- **If the shared key is being abused**, set `"revoked": true` on it. That
  turns off everybody's AI checks until a build with a new key is out, so it is
  for a real problem, not a busy day.

## Models

Models get retired, and a retired one answers every request with error 5028.
So each kind of check has a list, tried in order, and a retired model costs one
wasted call rather than a day of outage.

```
full check    @cf/meta/llama-3.3-70b-instruct-fp8-fast   best; on the JSON-mode list
              @cf/google/gemma-4-26b-a4b-it
              @cf/zai-org/glm-4.7-flash
              @cf/ibm-granite/granite-4.0-h-micro         last resort only

quick check   @cf/ibm-granite/granite-4.0-h-micro         ~1 neuron a sentence, 3 at most
              @cf/google/gemma-4-26b-a4b-it               ~3, up to 10; used by itself if Granite stops answering
```

Llama 3.1 8B and Llama 3.2 3B used to be on the full list. Both are retired on
2026-11-20 and have been taken off; if `MODEL` still names either one, remove
it.

Only the 70B is on Workers AI's JSON-mode list. For the others the Worker asks
for the schema anyway, retries without it if the model refuses, and digs the
JSON out of whatever comes back — which is also why the quick prompt spells the
JSON shape out in full.

The small model is the real risk. Proofreading is exactly where a small model
gets sloppy, and a checker that invents corrections is worse than one that
stays quiet. Before changing either list, try the candidate on a few paragraphs
you know — including some that are already correct — and watch for it
"fixing" things that were fine. (`npm run quality` scores Caret's built-in
checks, not these models.)

## What it does and does not keep

The Worker never stores or logs the text it is sent. The only things written to
KV are the keys themselves, two per-key day counters — `use:<key>:<date>` for
full checks and `quick:<key>:<date>` for quick ones — and one for the whole
account, `neurons:full:<date>`, the full checks' running cost: a number, with
no key or text in it. The counters expire after 36 hours.

But be clear with the people you give a key to: with a `caret_` key their text
goes through **your** Cloudflare account on its way to the model. That is a
different arrangement from the other providers, where it goes straight from
their browser to a service they signed up for themselves. If Caret ever ships
this endpoint in the published store build, the privacy page and the Edge
store's data-collection answers both need updating to say so.

## Shape of it

```
POST /check
  x-caret-key: caret_…
  { "text": "...", "mode": "quick", "leaveAlone": ["Kitson"] }
                    ^ optional: "quick" for one sentence, anything else is a full check

200  { "corrections": [ { before, original, replacement, kind, explanation } ],
       "model": "...", "left": 99, "mode": "full" | "quick" }
400  the body is not a JSON object
401  not a key / unknown key
403  key turned off
429  this key's daily cap for that kind of check; or, for a full
     check, today's full-check share is used up for everyone; or
     the account allowance is spent ("spent": true)             → Caret goes quiet
502  no model would answer
503  KV is unreachable, so the key cannot be checked

GET /health
200  { "ok": true, "model": "...", "fallbacks": 4,
       "quickModel": "...", "quickFallbacks": 2 }
```

`left` is `null` for a full check on a key with no cap here, and an estimate
for a quick check (see above).

No answer carries CORS headers, and `OPTIONS` gets a bare 204 — see
[Who can call it](#who-can-call-it).

The `corrections` shape is identical to what every other provider returns, so
the extension runs it through exactly the same code. The system prompts and the
schema are imported from `src/shared/proofread.js` — one copy, shared with the
extension, so the two cannot drift apart.
