// Where the API key lives when you do not want a key box in the settings.
//
// Leave BUILT_IN_KEY empty and Caret asks for a key in the options page, keeps
// it in this browser profile, and sends it nowhere but the provider it belongs
// to. Put a key in and the options page drops the box and shows a single
// switch instead.
//
//   HOW TO SET YOURS
//   Put your key between the quotes below, reload the extension, done.
//
//   Two things to know before you do:
//
//   1. This file IS tracked by git. A key left here goes up with your next
//      push, and this repository is public. Either keep the keyed copy only on
//      your own machine, or run this once so git stops watching the file:
//          git update-index --skip-worktree src/shared/apikey.js
//
//   2. A key baked into the extension is readable by anyone who installs it -
//      an extension is a zip file, and the store hands it to whoever asks. So
//      keep the keyed build for yourself (edge://extensions, Load unpacked)
//      and publish the build with this left empty.
//
//   A Google AI Studio key is the one worth baking in: its free tier needs no
//   card, so the worst case if it leaks is that someone else uses up a free
//   quota. Never bake in a key with billing attached.

export const BUILT_IN_KEY = '';

// The Caret Worker this build talks to, if there is one. Not a secret: it is
// the per-person caret_ key that decides who may use it, and that is why the
// Worker checks one on every request.
export const CARET_ENDPOINT = 'https://summer-scene-fd09.timoth-5db.workers.dev';

/** 'caret' | 'gemini' | 'openai' | 'anthropic' | null - from the key itself. */
export function providerFor(key) {
  const k = (key || '').trim();
  if (!k) return null;
  if (/^caret_[A-Za-z0-9_-]{8,64}$/.test(k)) return 'caret';
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-')) return 'openai';
  // Google AI Studio keys: always this prefix, 39 characters.
  if (/^AIza[\w-]{20,}$/.test(k)) return 'gemini';
  return null;
}
