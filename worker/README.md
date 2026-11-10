# The Caret Worker

A free AI proofreading pass for a small, known group of people — you, your dad,
and about ten others. One Cloudflare account runs the model; everybody else
pastes a short `caret_…` key and never touches an API console.

**This is not a service.** Workers AI's free plan gives the whole account
**10,000 neurons a day**, reset at 00:00 UTC, and when they are gone every
request fails until the reset. That is roughly 900–1,200 checks a day shared
between everyone. Hence the per-key daily cap: without it, one person leaving
*after every pause* switched on takes the day's allowance before lunch.

## What you do

Everything below is free and needs no card.

### 1. Make the account

[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — email and
password, confirm it.

Then click **Compute (Workers)** in the sidebar. It asks you to choose a
subdomain the first time. Whatever you pick becomes part of your public URL,
and changing it later is awkward, so choose one you like.

### 2. Deploy it

From this folder, with Node installed:

```sh
npx wrangler login                              # opens a browser, approve once
npx wrangler kv namespace create CARET_KEYS     # prints an id
```

Put that id into `wrangler.toml` where it says `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`,
then:

```sh
npx wrangler deploy
```

It prints the URL — `https://caret-ai.<your-subdomain>.workers.dev`. Open
`/health` on it in a browser and you should see
`{"ok":true,"model":"@cf/meta/llama-3.1-8b-instruct"}`.

### 3. Make a key for each person

A key is any string starting `caret_`. Make them unguessable, not memorable:

```sh
npx wrangler kv key put --binding=KEYS "key:caret_$(openssl rand -hex 12)" \
  '{"name":"Dad","daily":120}' --remote
```

`name` is only so you can tell them apart in the KV list; `daily` is that
person's own cap. To turn a key off later, set `{"revoked":true}` on it.

### 4. Tell me the URL

Paste the `https://caret-ai.….workers.dev` URL into the chat and I will set
`CARET_ENDPOINT` in `src/shared/apikey.js`, rebuild the package, and send you a
version to upload. The URL is not a secret — the per-person key is what gates
it, which is why the Worker checks one on every single request.

## Before you commit to a model

`@cf/google/gemma-4-26b-a4b-it` was the original suggestion, but **it is not on
Workers AI's JSON-mode list** — the documented list is Llama 3.3 70B fp8-fast,
Llama 3/3.1 8B, Hermes 2 Pro and the DeepSeek distills. The Worker asks for
JSON mode and also parses defensively, so an off-list model may still work, but
it is not guaranteed.

The small model is the real risk here. Proofreading is exactly where an 8B
model gets sloppy, and a checker that invents corrections is worse than one
that stays quiet. Run `npm run quality` from the repo root against each
candidate before settling:

```
MODEL = "@cf/meta/llama-3.1-8b-instruct"            cheapest per call
MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"  better, fewer calls per day
```

Change `MODEL` in `wrangler.toml` and deploy again.

## What it does and does not keep

The Worker never stores or logs the text it is sent. The only things written to
KV are the keys themselves and a per-key counter that expires after 36 hours.

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
  { "text": "..." }

200  { "corrections": [ { before, original, replacement, kind, explanation } ],
       "model": "...", "left": 118 }
401  not a key / unknown key
403  key turned off
429  this key's daily cap, or the account allowance is spent  → Caret goes quiet
502  the model did not answer
```

The `corrections` shape is identical to what every other provider returns, so
the extension runs it through exactly the same code. The system prompt and the
schema are imported from `src/shared/proofread.js` — one copy, shared with the
extension, so the two cannot drift apart.
