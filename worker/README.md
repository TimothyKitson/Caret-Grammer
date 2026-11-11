# The Caret Worker

A free AI proofreading pass for a small, known group of people — you, your dad,
and about ten others. One Cloudflare account runs the model; everybody else
pastes a short `caret_…` key and never touches an API console.

**This is not a service.** Workers AI's free plan gives the whole account
**10,000 neurons a day**, reset at 00:00 UTC, and when they are gone every
request fails until the reset. It does two kinds of check, and they cost very
different amounts of that:

| | model | neurons each | on its own, that is |
|---|---|---|---|
| **full check** — the whole field | Llama 3.3 70B | about 55 | ~180 a day |
| **quick check** — one finished sentence | IBM Granite 4.0 micro | about 1 (3–4 on Gemma) | thousands a day |

So the full check is the one that can run the account dry, and the caps below
are what stop it: without them, one person leaving *after every pause* switched
on takes the day's allowance before lunch. See
[Staying on the free plan](#staying-on-the-free-plan) for the numbers to set.

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
`{"name":"Everyone","daily":100}`.

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
  '{"name":"Dad","daily":100}' --remote
```

What a key's record can say:

| field | meaning |
|---|---|
| `name` | only so you can tell them apart in the KV list |
| `daily` | full checks a day on this key. `0` or missing = not capped here (the extension still caps each person) |
| `quickDaily` | quick checks a day on this key. `0` or missing = `QUICK_DAILY`, or 2,000 |
| `revoked` | `true` turns the key off, for both kinds of check |

### 4. Tell me the URL

Paste the `https://caret-ai.….workers.dev` URL into the chat and I will set
`CARET_ENDPOINT` in `src/shared/apikey.js`, rebuild the package, and send you a
version to upload. The URL is not a secret — the per-person key is what gates
it, which is why the Worker checks one on every single request.

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

## The quick check

The extension can send each sentence to the Worker as the person finishes it.
That request carries `"mode": "quick"` and gets a different, much cheaper
treatment:

- **Its own models.** IBM Granite 4.0 micro first, then Gemma 4 26B. Never the
  70B, not even as a last resort: at a couple of thousand sentences a day,
  quietly falling back to a model twenty times the price would empty the
  account.
- **Its own prompt.** `QUICK_SYSTEM_PROMPT` in `src/shared/proofread.js` — the
  full check's rules cut down to under 900 characters, because it is paid for
  on every sentence. Same JSON answer, so the extension handles it the same way.
- **One sentence.** The text is cut at 800 characters and the answer at 256
  tokens. Only the person's leave-alone words that actually appear in the
  sentence go into the prompt.
- **Its own count.** Kept apart from the full check's, so a day of typing never
  uses up anybody's full checks, and the other way round.

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
failing — both kinds. Only a key that cannot be looked up at all is refused
(503), since then nobody knows whether it is a real one.

## Settings

All optional. Set them as **plain text variables** in the Worker's Settings, or
under `[vars]` in `wrangler.toml`.

| variable | default | what it does |
|---|---|---|
| `MODEL` | *(empty)* | forces a model to the front of the full check's list |
| `PER_KEY_DAILY` | `0` | full checks a day for a key with no `daily` of its own. `0` = not capped here |
| `QUICK_MODEL` | *(empty)* | forces a model to the front of the quick check's list |
| `QUICK_DAILY` | `2000` | quick checks a day for a key with no `quickDaily` of its own. `0` = the default, not "no cap" |

## Staying on the free plan

Most copies of Caret share one key, so that key's two caps are, in practice,
the whole group's budget. Set them so the two kinds of check fit under 10,000
neurons together:

| | cap | neurons each | worst day |
|---|---|---|---|
| full checks | `"daily": 100` on the shared key | ~55 | ~5,500 |
| quick checks | `QUICK_DAILY` 2,000 (the default) | ~1 on Granite | ~2,000 |
| **total** | | | **~7,500 of 10,000** |

- **Set `"daily"` to about 100 on the shared key.** At 200, full checks alone
  could cost ~11,000 neurons — more than the whole day — and the quick check
  would have nothing left.
- **If you switch `QUICK_MODEL` to Gemma**, each quick check costs three or four
  times as much. Bring `QUICK_DAILY` down to about 1,000 (~3,500 neurons) to
  stay under.
- Never point `QUICK_MODEL` at the 70B. It would work, at 10–20 neurons a
  sentence, and the default 2,000 would cost two to four times the day's
  allowance.
- KV stays well inside its free plan too: about one write per full check and
  one per ten quick checks (~300 a day at the caps above, of 1,000), and two
  reads per check of either kind (~4,200, of 100,000).

Each copy of Caret also caps its own person — 10 full checks a day, and 30
quick ones unless they raise it, never past 100. Ten people using every check
they have come to 100 full checks and 300–1,000 quick ones: right at the full
cap, well under the quick one. The Worker's caps are for the day something goes
wrong — a key that got out, or more people than planned — and a key that
reaches one gets a 429, which Caret treats as "quiet until tomorrow", not as an
error.

When the account's allowance does run out anyway, every request gets a 429
with `"spent": true` until midnight UTC, and Caret goes quiet rather than
showing an error. The built-in checks carry on as normal.

## Models

Models get retired, and a retired one answers every request with error 5028.
So each kind of check has a list, tried in order, and a retired model costs one
wasted call rather than a day of outage.

```
full check    @cf/meta/llama-3.3-70b-instruct-fp8-fast   best; on the JSON-mode list
              @cf/google/gemma-4-26b-a4b-it
              @cf/zai-org/glm-4.7-flash
              @cf/ibm-granite/granite-4.0-h-micro         last resort only

quick check   @cf/ibm-granite/granite-4.0-h-micro         ~1 neuron a sentence
              @cf/google/gemma-4-26b-a4b-it               ~3-4
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
KV are the keys themselves and two per-key day counters — `use:<key>:<date>`
for full checks and `quick:<key>:<date>` for quick ones — which expire after 36
hours.

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
429  this key's daily cap for that kind of check, or the account
     allowance is spent ("spent": true)                         → Caret goes quiet
502  no model would answer
503  KV is unreachable, so the key cannot be checked

GET /health
200  { "ok": true, "model": "...", "fallbacks": 4,
       "quickModel": "...", "quickFallbacks": 2 }
```

`left` is `null` for a full check on a key with no cap here, and an estimate
for a quick check (see above).

The `corrections` shape is identical to what every other provider returns, so
the extension runs it through exactly the same code. The system prompts and the
schema are imported from `src/shared/proofread.js` — one copy, shared with the
extension, so the two cannot drift apart.
