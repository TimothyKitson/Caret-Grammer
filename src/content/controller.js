// The part that watches what you type.
//
// One field at a time - whichever you are working in. Text goes to the service
// worker, issues come back with offsets, the adapter turns those into
// rectangles, and the overlay draws them. Hovering an underline opens the card;
// clicking a suggestion writes it back through the adapter.

(() => {
  const NS = window.__caret;
  if (!NS || NS.started) return;
  NS.started = true;

  const LOCAL_DELAY = 400;      // after the last keystroke
  const AI_DELAY = 1500;        // longer: it costs money and network
  const HOVER_DELAY = 90;
  const HIDE_GRACE = 220;
  const MAX_CHARS = 30000;
  const MIN_AI_CHARS = 12;
  const QUICK_IDLE = 2000;      // a pause this long after a full stop finishes a sentence

  // Never send anything that looks like a card number or a national ID to an
  // API, whatever the field says it is.
  const SENSITIVE = [
    /\b(?:\d[ -]?){13,16}\b/,
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b(?:sk|pk|api[_-]?key|password|secret|token)[-_ ]?[:=]/i,
  ];

  const overlay = NS.createOverlay();
  const adapters = new WeakMap();

  let settings = null;
  let siteEnabled = true;
  let active = null;          // {adapter, issues, text, version}
  let localTimer = null;
  let aiTimer = null;
  let hoverTimer = null;
  let hideTimer = null;
  let frame = null;
  let version = 0;
  let lastAiAt = 0;
  let lastAiText = null;
  let dead = false;
  let pointer = { x: -1, y: -1 };
  let quickIdleTimer = null;
  let quickBlockedUntil = 0;
  let quickSuppress = 0;        // > 0 while Caret itself is editing the field
  let checkKeys = '';           // the "Proofread with AI" shortcut, as the browser has it
  let aiLeftToday = null;       // full AI checks left today; null = no limit or not known

  // ---------------------------------------------------------------- plumbing

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (_) {
        // The extension was reloaded or removed: stand down quietly.
        dead = true;
        teardown();
        resolve(null);
      }
    });
  }

  function teardown() {
    if (active) {
      restoreNative(active.adapter.element);
      active.adapter.dispose();
    }
    overlay.clearUnderlines();
    overlay.hideCard();
    overlay.hideBadge();
    overlay.hidePanel();
    active = null;
    lastFix = null;
  }

  /**
   * This frame's own address, plus the address of the page that embeds it, so
   * turning a site off also silences third-party boxes inside its pages.
   */
  function frameHrefs() {
    const list = [location.href];
    try {
      const origins = location.ancestorOrigins;
      if (origins && origins.length) list.push(origins[origins.length - 1]);
    } catch (_) { /* not available */ }
    return list;
  }

  async function loadSettings() {
    const response = await send({ type: 'get-state', hrefs: frameHrefs() });
    if (!response) return false;
    settings = response.settings;
    siteEnabled = response.siteEnabled;
    checkKeys = typeof response.checkKeys === 'string' ? response.checkKeys : '';
    aiLeftToday = typeof response.aiLeftToday === 'number' ? response.aiLeftToday : null;
    overlay.setUnderlineStyle(settings.underlineStyle);
    return true;
  }

  function enabled() {
    return !dead && settings && settings.enabled && siteEnabled;
  }

  function deepTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    return (path && path[0]) || event.target;
  }

  function adapterFor(el) {
    let adapter = adapters.get(el);
    if (adapter) return adapter;
    adapter = NS.createAdapter(el, overlay.mirrorHost);
    if (adapter) adapters.set(el, adapter);
    return adapter;
  }

  // ------------------------------------------------------------------ checks

  function scheduleCheck({ immediate = false, ai = false, localOnly = false } = {}) {
    if (!enabled() || !active) return;
    clearTimeout(localTimer);
    localTimer = setTimeout(runCheck, immediate ? 0 : LOCAL_DELAY);
    // A redraw for something Caret did itself - a quick-check answer, a full
    // check's answer arriving late - is not a pause in typing, and must not
    // set the full check's timer going again.
    if (localOnly) return;
    clearTimeout(aiTimer);
    // An AI pass costs money every time, so when it happens is the user's call.
    //   manual    only when asked - the right-click menu, Ctrl+Shift+. , or the
    //             right-click menu. Arrives here as ai: true.
    //   interval  at most once every aiIntervalMinutes in this field.
    //   auto      after every pause in typing.
    if (!settings.aiEnabled) return;
    if (ai) { aiTimer = setTimeout(() => runCheck({ ai: true }), 0); return; }
    if (settings.aiTrigger === 'auto') {
      aiTimer = setTimeout(() => runCheck({ ai: true }), AI_DELAY);
      return;
    }
    if (settings.aiTrigger === 'interval') {
      const gap = Math.max(1, Number(settings.aiIntervalMinutes) || 1) * 60000;
      const due = Math.max(AI_DELAY, gap - (Date.now() - lastAiAt));
      aiTimer = setTimeout(() => runCheck({ ai: true }), due);
    }
  }

  async function runCheck({ ai = false } = {}) {
    if (!enabled() || !active) return;
    const adapter = active.adapter;
    if (!adapter.element.isConnected) { teardown(); return; }
    let text = adapter.getText();
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

    const wantAi = ai && settings.aiEnabled && active.userEdited
      && text.trim().length >= MIN_AI_CHARS
      && !SENSITIVE.some((re) => re.test(text));
    if (wantAi && lastAiText === text && active.issues) return;

    const mine = (version += 1);
    if (settings.showBadge) drawBadge('busy');
    const response = await send({
      type: 'check',
      text,
      hrefs: frameHrefs(),
      wantAi,
      kind: adapter.kind,
      quickIssues: quickIssuesIn(adapter, text),
    });
    if (!response || !active || active.adapter !== adapter) return;
    if (mine !== version) {
      // Something newer started while this was out - often just a redraw for
      // a quick-check answer. If this one carried a full AI check that ran on
      // text still in the field, keep it: note it as done, so it is not paid
      // for twice, and redraw, which picks its findings up from the cache.
      if (wantAi && response.aiRan && adapter.getText().slice(0, MAX_CHARS) === text) {
        lastAiText = text;
        lastAiAt = Date.now();
        scheduleCheck({ immediate: true, localOnly: true });
      }
      return;
    }
    if (typeof response.aiLeft === 'number') aiLeftToday = response.aiLeft;
    if (response.error) {
      active.issues = active.issues || [];
      render();
      return;
    }
    // Only remember it as checked if the request really went out: the worker
    // drops calls that hit its rate limit, and that text deserves another go.
    if (wantAi && response.aiRan) { lastAiText = text; lastAiAt = Date.now(); }
    active.text = text;
    active.issues = response.issues || [];
    render();
  }

  // ------------------------------------------------------------------ render

  function render() {
    if (!active || !enabled()) return;
    const { adapter, issues } = active;
    if (!adapter.element.isConnected || !adapter.isVisible()) {
      // The field went away - a single-page app swapped the view, say. Take
      // the whole overlay with it, or a pinned card sits there eating clicks.
      overlay.clearUnderlines();
      overlay.hideBadge();
      overlay.hideCard();
      overlay.hidePanel();
      return;
    }
    if (adapter.invalidate) adapter.invalidate();
    const entries = [];
    for (const issue of issues || []) {
      const rects = adapter.rectsFor(issue.start, issue.end);
      if (rects.length) entries.push({ issue, rects });
    }
    overlay.drawUnderlines(entries);
    active.entries = entries;
    if (settings.showBadge) drawBadge((issues || []).length ? 'has' : 'clean');
    else overlay.hideBadge();

    // A pinned card follows its issue; if the issue is gone, so is the card.
    const pinned = overlay.cardIssueRef();
    if (pinned) {
      const entry = entries.find((e) => e.issue === pinned);
      if (!entry) overlay.hideCard();
      else if (!overlay.isCardHovered()) {
        overlay.showCard({
          issue: pinned,
          rect: entry.rects[0],
          sticky: overlay.isCardSticky(),
          canAddWord: pinned.category === 'spelling',
          handlers: cardHandlers,
        });
      }
    }
    if (overlay.isPanelOpen()) openPanel(true);
  }

  function drawBadge(state) {
    if (!active || !settings.showBadge) return;
    const el = active.adapter.element;
    if (!active.adapter.isVisible()) { overlay.hideBadge(); return; }
    const box = el.getBoundingClientRect();
    if (box.width < 60 || box.height < 22) { overlay.hideBadge(); return; }
    // Keep clear of the field's own scrollbar and resize handle.
    const style = getComputedStyle(el);
    const borderX = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
    const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const scrollbarX = Math.max(0, el.offsetWidth - el.clientWidth - borderX);
    const scrollbarY = Math.max(0, el.offsetHeight - el.clientHeight - borderY);
    const rect = {
      left: box.left,
      top: box.top,
      right: box.right - scrollbarX - 1,
      bottom: box.bottom - scrollbarY - 1,
      width: box.width,
      height: box.height,
    };
    overlay.showBadge({
      rect,
      count: (active.issues || []).length,
      state,
      handlers: { onClick: () => (overlay.isPanelOpen() ? overlay.hidePanel() : openPanel()) },
    });
  }

  function reposition() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      render();
    });
  }

  // ------------------------------------------------------------- autocorrect

  // Words the user undid a correction on. They are left alone from then on,
  // because the second time you fight the same autocorrect is the time you
  // uninstall it.
  const refused = new Set();
  let lastFix = null;

  function autocorrectOn() {
    return !!(settings && settings.autocorrect && settings.autocorrect.enabled);
  }

  /** Did the user just undo the correction we made? Then never make it again. */
  function noticeUndo(text) {
    if (!lastFix) return;
    const { start, original, fixed, at } = lastFix;
    if (Date.now() - at > 15000) { lastFix = null; return; }
    // Is the correction still in the text? Look in a window around where we put
    // it rather than at the exact spot, because typing earlier in the field
    // slides it along and that is not an undo.
    const seen = text.indexOf(fixed, Math.max(0, start - 60));
    if (seen !== -1 && seen <= start + 60) return;
    // It is gone. Undone, retyped, deleted - it does not matter which: they did
    // not want it, so that word is theirs from now on.
    refused.add(original.toLowerCase());
    lastFix = null;
  }

  // What autocorrect needs to know about a field, worked out once per field.
  const fieldFacts = new WeakMap();
  // Named code fonts. Not the bare word "monospace": that is what Chrome gives
  // every <textarea> nobody styled, and most of those are ordinary boxes.
  const CODE_FONT = /\b(?:courier|consolas|menlo|monaco|source code|fira (?:code|mono)|jetbrains|sf mono|ubuntu mono|roboto mono|dejavu sans mono|liberation mono|cascadia|hack|inconsolata|andale mono|lucida console)\b/i;
  const CODE_EDITOR = '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor, pre, code, [data-language]';

  function factsFor(adapter) {
    let facts = fieldFacts.get(adapter);
    if (facts) return facts;
    const el = adapter.element;
    const langHolder = el.closest('[lang]:not([lang=""])');
    const capHolder = el.closest('[autocapitalize]') || (el.form && el.form.hasAttribute('autocapitalize') ? el.form : null);
    let code = !!el.closest(CODE_EDITOR);
    if (!code) {
      try {
        const family = getComputedStyle(el).fontFamily || '';
        // A box a site deliberately set in a plain "monospace" is a code box;
        // a textarea in it is just unstyled.
        const fonts = family.split(',').map((f) => f.trim().replace(/["']/g, '').toLowerCase());
        code = fonts.some((f) => f !== 'monospace' && (/mono/.test(f) || CODE_FONT.test(f)))
          || (el.tagName !== 'TEXTAREA' && /^\s*monospace\s*$/i.test(family));
      } catch (_) { /* detached */ }
    }
    facts = {
      kind: adapter.kind,
      type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '',
      lang: (langHolder && langHolder.getAttribute('lang')) || '',
      autocapitalize: ((capHolder && capHolder.getAttribute('autocapitalize')) || '').toLowerCase(),
      code,
    };
    fieldFacts.set(adapter, facts);
    return facts;
  }

  function applyFixAt(adapter, start, end, fixed, caret) {
    const shift = fixed.length - (end - start);
    const before = adapter.getText();
    // Caret's own edit, not the person's: the quick check is told about it
    // directly rather than seeing it as typing.
    quickSuppress += 1;
    let ok;
    try {
      ok = adapter.replaceRange(start, end, fixed, caret + shift);
    } finally {
      quickSuppress -= 1;
    }
    if (!ok) return false;
    quickAfterFix(adapter, before, { start, end }, fixed);
    if (adapter.invalidate) adapter.invalidate();
    return true;
  }

  function autocorrect(event) {
    if (!enabled() || !autocorrectOn() || !NS.autocorrect) return;
    if (!event.isTrusted || event.isComposing) return;
    // Undo arrives as its own input event, so look for one before the filter
    // below throws every non-typing event away.
    const adapter = active.adapter;
    const text = adapter.getText();
    noticeUndo(text);

    const kind = event.inputType;
    if (kind && !/^insert(Text|LineBreak|Paragraph)$/.test(kind)) return;
    if (kind === 'insertText' && event.data && event.data.length > 1) return;

    const caret = adapter.caret();
    if (caret === null || caret === undefined) return;

    const found = NS.autocorrect.wordBefore(text, caret);
    if (!found) return;
    const lower = found.word.toLowerCase();
    if (refused.has(lower)) return;

    const field = factsFor(adapter);
    const options = {
      autocorrect: settings.autocorrect,
      skip: refused,
      known: new Set(settings.customWords || []),
      field,
    };
    const decision = NS.autocorrect.decide(found, text, options);
    if (decision) {
      if (applyFixAt(adapter, found.start, found.end, decision.fixed, caret)) {
        lastFix = { start: found.start, original: found.word, fixed: decision.fixed, at: Date.now() };
      }
      return;
    }

    // Documented typos live in the worker, with the dictionary. The round trip
    // is a few milliseconds, and the text is re-checked before anything moves.
    if (settings.autocorrect.commonTypos === false) return;
    if (found.late || field.code || NS.autocorrect.looksLikeCode(text, found.start)) return;
    if (/^(email|url|tel)$/.test(field.type)) return;
    if (field.lang && !/^en\b/i.test(field.lang)) return;
    const snapshot = { start: found.start, end: found.end, word: found.word };
    send({ type: 'autocorrect-word', word: found.word }).then((reply) => {
      if (!reply || !reply.fix || !active || active.adapter !== adapter) return;
      const now = adapter.getText();
      if (now.slice(snapshot.start, snapshot.end) !== snapshot.word) return;   // they typed on
      const here = adapter.caret();
      if (here === null) return;
      if (applyFixAt(adapter, snapshot.start, snapshot.end, reply.fix, here)) {
        lastFix = { start: snapshot.start, original: snapshot.word, fixed: reply.fix, at: Date.now() };
        scheduleCheck();
      }
    });
  }

  // ------------------------------------------------------------- quick check
  //
  // Caret's small AI, one sentence at a time. A sentence is sent once it is
  // finished - it has its full stop, question mark or exclamation mark - and
  // you have moved on from it. It is sent again only if you change it and move
  // on again. The decision about which sentence is due lives in sentences.js;
  // this part only listens, queues and places the answers.

  const quickState = new WeakMap();   // adapter -> {tracker, results, queue, busy}
  // Answers are kept per frame, not per field: when a site rebuilds its editor
  // (Ignitia's check button), the new field holds the same sentences, and the
  // answers already paid for still apply to them.
  const quickResults = new Map();     // sentence -> issues relative to it
  const QUICK_RESULTS_MAX = 300;

  function quickOn() {
    return !!(settings && settings.quickAiEnabled && NS.sentences && enabled());
  }

  function isInActive(el) {
    if (!active || !el) return false;
    const field = active.adapter.element;
    return el === field || (typeof field.contains === 'function' && field.contains(el));
  }

  /** Fields where a sentence check makes no sense: code, addresses, numbers. */
  function quickSkipsField(adapter) {
    const facts = factsFor(adapter);
    return facts.code || /^(email|url|tel)$/.test(facts.type);
  }

  function quickFor(adapter) {
    let state = quickState.get(adapter);
    if (!state) {
      // Whatever is already in the field is the starting point: it was not
      // typed just now, so it is not checked unless it is changed.
      state = {
        tracker: NS.sentences.createTracker(adapter.getText().slice(0, MAX_CHARS)),
        results: quickResults,
        queue: [],
        busy: false,
      };
      quickState.set(adapter, state);
    }
    return state;
  }

  function quickNote(kind, inputType = '') {
    if (!quickOn() || !active) return;
    const adapter = active.adapter;
    if (quickSkipsField(adapter)) return;
    const state = quickFor(adapter);
    const text = adapter.getText().slice(0, MAX_CHARS);
    let due;
    if (kind === 'leave') {
      due = state.tracker.leave(text);
    } else {
      const caret = adapter.caret();
      const pasted = kind === 'input' && /^insertFrom/.test(inputType);
      // After a paste the caret can be unknown for a moment; the tracker still
      // needs to hear about the paste so the pasted sentences are not sent.
      if ((caret === null || caret === undefined) && !pasted) return;
      if (kind === 'input') due = state.tracker.input(text, caret ?? null, inputType);
      else if (kind === 'idle') due = state.tracker.idle(text, caret);
      else due = state.tracker.caret(text, caret);
    }
    for (const sentence of due || []) enqueueQuick(adapter, state, sentence);
  }

  function enqueueQuick(adapter, state, sentence) {
    // A card number or a password is not sent anywhere, blanked or not.
    if (SENSITIVE.some((re) => re.test(sentence))) return;
    if (state.queue.includes(sentence) || state.results.has(sentence)) return;
    state.queue.push(sentence);
    pumpQuick(adapter, state);
  }

  async function pumpQuick(adapter, state) {
    if (state.busy) return;
    state.busy = true;
    try {
      while (state.queue.length) {
        if (!quickOn() || Date.now() < quickBlockedUntil) { state.queue.length = 0; break; }
        const sentence = state.queue.shift();
        // Rewritten or deleted while it waited: nothing left to check.
        if (!adapter.getText().includes(sentence)) continue;
        const reply = await send({ type: 'quick-check', sentence });
        if (!reply) break;
        if (reply.capped || reply.paused) {
          // Today's checks are used up, or the shared allowance is: stop
          // asking for a while instead of asking for every sentence.
          quickBlockedUntil = Date.now() + (reply.capped ? 30 : 10) * 60000;
          state.queue.length = 0;
          break;
        }
        if (!Array.isArray(reply.issues)) continue;
        if (state.results.size >= QUICK_RESULTS_MAX) {
          state.results.delete(state.results.keys().next().value);
        }
        state.results.set(sentence, reply.issues);
        if (reply.issues.length && active && active.adapter === adapter) {
          scheduleCheck({ immediate: true, localOnly: true });
        }
      }
    } finally {
      state.busy = false;
    }
  }

  /** Every quick-check finding, placed wherever its sentence is right now. */
  function quickIssuesIn(adapter, text) {
    if (!quickOn()) return [];
    const state = quickState.get(adapter);
    if (!state || !state.results.size) return [];
    const out = [];
    for (const segment of NS.sentences.segments(text)) {
      const found = state.results.get(segment.text);
      if (!found || !found.length) continue;
      for (const issue of found) {
        out.push({ ...issue, start: issue.start + segment.start, end: issue.end + segment.start });
      }
    }
    return out;
  }

  /**
   * After a suggestion is applied, the sentence it was in has new text. If the
   * old text had already been checked, the new one counts as checked too, with
   * whatever else was found in it carried over - accepting a fix is not a
   * reason to spend another check on the same sentence.
   */
  function quickAfterFix(adapter, before, issue, replacement) {
    const state = quickState.get(adapter);
    if (!state) return;
    const delta = replacement.length - (issue.end - issue.start);
    state.tracker.shift(issue.start, delta, adapter.getText().slice(0, MAX_CHARS));
    const old = NS.sentences.segmentAt(before, issue.start);
    if (!old || issue.end > old.end) return;
    const after = adapter.getText();
    const next = NS.sentences.segmentAt(after, old.start);
    if (!next || next.text === old.text) return;
    const relStart = issue.start - old.start;
    const relEnd = issue.end - old.start;
    const previous = state.results.get(old.text);
    if (previous) {
      const carried = previous
        .filter((other) => other.end <= relStart || other.start >= relEnd)
        .map((other) => (other.start >= relEnd
          ? { ...other, start: other.start + delta, end: other.end + delta }
          : other))
        .filter((other) => next.text.slice(other.start, other.end) === other.text);
      state.results.set(next.text, carried);
    }
    if (previous || state.tracker.isSettled(old.text)) state.tracker.settle(next.text);
  }

  // ------------------------------------------------------------------ actions

  function applyFix(issue, replacement) {
    if (!active) return;
    const { adapter } = active;
    const current = adapter.getText().slice(issue.start, issue.end);
    if (current !== issue.text) {
      // The text moved under us. Re-check rather than corrupt the field.
      overlay.hideCard();
      scheduleCheck({ immediate: true });
      return;
    }
    const before = adapter.getText();
    quickSuppress += 1;
    let ok;
    try {
      ok = adapter.replaceRange(issue.start, issue.end, replacement);
    } finally {
      quickSuppress -= 1;
    }
    overlay.hideCard();
    if (!ok) return;
    quickAfterFix(adapter, before, issue, replacement);
    const shift = replacement.length - (issue.end - issue.start);
    active.issues = (active.issues || [])
      .filter((other) => other !== issue)
      .map((other) => (other.start >= issue.end
        ? { ...other, start: other.start + shift, end: other.end + shift }
        : other));
    render();
    scheduleCheck();
  }

  function fixAll() {
    if (!active) return;
    const fixable = (active.issues || [])
      // Claude's suggestions are never applied in bulk: each one is a judgement
      // call and gets its own click.
      .filter((issue) => issue.source !== 'ai')
      .filter((issue) => issue.replacements && issue.replacements.length && issue.confidence !== 'low')
      .sort((a, b) => b.start - a.start);   // back to front keeps offsets valid
    quickSuppress += 1;
    try {
      for (const issue of fixable) {
        const before = active.adapter.getText();
        if (before.slice(issue.start, issue.end) !== issue.text) continue;
        if (active.adapter.replaceRange(issue.start, issue.end, issue.replacements[0])) {
          // Same as one fix at a time: the sentence counts as checked still,
          // and what the quick check found in it stays.
          quickAfterFix(active.adapter, before, issue, issue.replacements[0]);
        }
      }
    } finally {
      quickSuppress -= 1;
    }
    overlay.hidePanel();
    scheduleCheck({ immediate: true });
  }

  const cardHandlers = {
    onApply: applyFix,
    onAddWord: async (issue) => {
      overlay.hideCard();
      // "Vlogging is fun." - the capital is the sentence's, not the word's.
      // Saving it would flag every lower-case "vlogging" as a misspelled name.
      const before = active ? active.adapter.getText().slice(0, issue.start) : '';
      const atStart = /(^|[.!?…]["'”’)\]]*\s+|\n\s*)$/.test(before);
      const word = atStart && /^[A-Z][a-z'’-]*$/.test(issue.text) ? issue.text.toLowerCase() : issue.text;
      await send({ type: 'add-word', word });
      lastAiText = null;
      scheduleCheck({ immediate: true });
    },
    onIgnore: async (issue) => {
      overlay.hideCard();
      await send({ type: 'ignore-issue', id: issue.id, text: issue.text });
      lastAiText = null;
      scheduleCheck({ immediate: true });
    },
    onSettings: () => send({ type: 'open-options' }),
  };

  /** The AI pass, because someone asked for it. */
  function runAiNow() {
    if (!active) return;
    lastAiText = null;
    active.userEdited = true;      // asking for it is intent enough
    scheduleCheck({ immediate: true, ai: true });
  }

  function openPanel(keepPosition = false) {
    if (!active) return;
    const el = active.adapter.element;
    const badgeRect = overlay.badgeRect();
    const rect = badgeRect || el.getBoundingClientRect();
    const issues = active.issues || [];
    overlay.showPanel({
      issues,
      rect,
      fixableCount: issues.filter((i) => i.source !== 'ai'
        && i.replacements && i.replacements.length && i.confidence !== 'low').length,
      aiCheck: settings.aiEnabled ? { keys: checkKeys, spent: aiLeftToday === 0 } : null,
      handlers: {
        onApply: (issue, replacement) => { overlay.hidePanel(); applyFix(issue, replacement); },
        onFixAll: fixAll,
        onAiCheck: () => {
          overlay.hidePanel();
          runAiNow();
        },
      },
    });
    if (keepPosition) return;
  }

  // ------------------------------------------------------------------- events

  // ------------------------------------------------- the browser's own checker
  //
  // Most sites do not ship a spell checker: the red squiggles are the browser's
  // own, and two sets of underlines disagreeing with each other is worse than
  // either alone. Switching spellcheck off on a field we are checking leaves
  // one opinion on screen.
  //
  // Every field we touch is put back exactly as it was - the attribute absent
  // if it was absent - because a page that keeps its own state can notice.
  const quieted = new WeakMap();

  function quietNative(el) {
    if (!el || quieted.has(el)) return;
    if (!settings || settings.quietOthers === false) return;
    quieted.set(el, el.hasAttribute('spellcheck') ? el.getAttribute('spellcheck') : null);
    // Set as the field gains focus, which is before Chrome's idle-time spell
    // pass gets to it. No blur-and-refocus to force a re-read: that fires the
    // site's own blur handlers (validation, "stopped typing", closing a
    // suggestions list) every time someone clicks into a box.
    el.setAttribute('spellcheck', 'false');
  }

  function restoreNative(el) {
    if (!el || !quieted.has(el)) return;
    const was = quieted.get(el);
    quieted.delete(el);
    if (was === null) el.removeAttribute('spellcheck');
    else el.setAttribute('spellcheck', was);
  }

  function activate(el) {
    if (!enabled()) return;
    const adapter = adapterFor(el);
    if (!adapter) return;
    if (active && active.adapter === adapter) return;
    // A correction we are still watching for an undo belongs to the field we
    // are leaving; looking for it in the next one would read as an undo.
    lastFix = null;
    if (active && active.adapter !== adapter) {
      restoreNative(active.adapter.element);
      overlay.clearUnderlines();
      overlay.hideCard();
      overlay.hidePanel();
      // Drop the previous field's measuring mirror; it is rebuilt on demand
      // if you click back into it.
      active.adapter.dispose();
    }
    active = { adapter, issues: [], text: '', entries: [], userEdited: false };
    // Start the quick check's record of this field now, before any typing, so
    // the first thing typed counts as typed.
    if (quickOn() && !quickSkipsField(adapter)) quickFor(adapter);
    quietNative(adapter.element);
    lastAiText = null;
    observeEditable(adapter);
    scheduleCheck({ immediate: true });
  }

  let mutationObserver = null;
  let resizeObserver = null;
  let observedScrollTargets = [];

  function observeEditable(adapter) {
    if (mutationObserver) mutationObserver.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    for (const target of observedScrollTargets) target.removeEventListener('scroll', reposition);
    observedScrollTargets = adapter.scrollTargets();
    for (const target of observedScrollTargets) {
      target.addEventListener('scroll', reposition, { passive: true });
    }
    resizeObserver = new ResizeObserver(reposition);
    try { resizeObserver.observe(adapter.element); } catch (_) { /* detached */ }
    if (adapter.kind === 'contenteditable') {
      mutationObserver = new MutationObserver(() => scheduleCheck());
      mutationObserver.observe(adapter.element, {
        childList: true, characterData: true, subtree: true,
      });
    }
  }

  // Every listener on the page goes through on(), so they can all be put back.
  //
  // Some editors rebuild themselves by rewriting their whole document with
  // document.open() - Ignitia's Writer does it when you press its check
  // button. The browser wipes every event listener in that document when it
  // does, ours included, and Caret would sit there dead until a reload. The
  // Document object itself survives, so adding the same listeners again brings
  // everything back. addEventListener ignores an exact duplicate, so putting
  // one back that was never lost is harmless.
  const listeners = [];
  function on(target, type, fn, options) {
    listeners.push([target, type, fn, options]);
    target.addEventListener(type, fn, options);
  }
  function relisten() {
    for (const [target, type, fn, options] of listeners) target.addEventListener(type, fn, options);
  }

  /** The focused element, looking inside shadow roots. */
  function focusedElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // A rewritten document has a new <html> element. Watch for that directly,
  // and check again on the timer below in case the observer missed it.
  let knownRoot = document.documentElement;
  function heal() {
    if (dead || document.documentElement === knownRoot) return;
    knownRoot = document.documentElement;
    relisten();
    // The field we were watching went with the old document.
    if (active && !active.adapter.element.isConnected) teardown();
    // The person is usually already back in the new editor: pick it up now
    // rather than waiting for a focus event that has already happened.
    setTimeout(() => {
      // An unfocused frame's editor is its activeElement too; only pick up
      // the one the person is actually in.
      if (!document.hasFocus()) return;
      const el = focusedElement();
      if (!active && el && NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
    }, 0);
  }
  try {
    new MutationObserver(heal).observe(document, { childList: true });
  } catch (_) { /* no document to watch */ }

  on(document, 'focusin', (event) => {
    const el = deepTarget(event);
    // Do this before anything else: a field that is a password now must stay
    // excluded even if the site turns it into a text field later.
    if (NS.rememberIfSecret) NS.rememberIfSecret(el);
    if (NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
  }, true);

  on(document, 'input', (event) => {
    const el = deepTarget(event);
    if (!active) {
      if (NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
      return;
    }
    if (el === active.adapter.element || active.adapter.element.contains(el)) {
      // isTrusted separates a person typing from a script setting .value,
      // which is what gates the (paid, off-computer) AI pass.
      if (event.isTrusted) active.userEdited = true;
      overlay.hidePanel();
      autocorrect(event);
      if (event.isTrusted && !event.isComposing && !quickSuppress) {
        quickNote('input', event.inputType);
        clearTimeout(quickIdleTimer);
        quickIdleTimer = setTimeout(() => quickNote('idle'), QUICK_IDLE);
      }
      scheduleCheck();
    }
  }, true);

  // Moving the caret without typing - arrow keys, a click - can be leaving the
  // sentence you just changed, which is when that sentence gets its check.
  const CARET_KEYS = new Set([
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
  ]);
  on(document, 'keyup', (event) => {
    if (!active || !CARET_KEYS.has(event.key)) return;
    if (isInActive(deepTarget(event))) quickNote('caret');
  }, true);
  on(document, 'mouseup', (event) => {
    if (!active) return;
    // After the browser has placed the caret.
    if (isInActive(deepTarget(event))) setTimeout(() => quickNote('caret'), 0);
  }, true);
  on(document, 'compositionend', (event) => {
    if (active && isInActive(deepTarget(event))) quickNote('input', 'insertCompositionText');
  }, true);
  on(document, 'focusout', (event) => {
    if (!active || deepTarget(event) !== active.adapter.element) return;
    // Switching to another tab or window blurs the field too, but the person
    // has not moved on: they come back to the same spot. In the top frame the
    // field keeps being the active element while the document loses focus.
    if (window === window.top && !document.hasFocus() && focusedElement() === active.adapter.element) return;
    clearTimeout(quickIdleTimer);
    if (window !== window.top) {
      // Inside a frame a tab switch looks like any other blur; the only tell
      // is that the page is hidden a moment later.
      setTimeout(() => { if (document.visibilityState !== 'hidden') quickNote('leave'); }, 60);
      return;
    }
    quickNote('leave');
  }, true);

  // Editors that handle paste themselves (ProseMirror, Quill, CKEditor,
  // Lexical, TinyMCE) cancel the browser's paste, so no "insertFromPaste"
  // input event arrives. Tell the quick check about the paste directly, once
  // the editor has put the text in.
  const notePaste = (event) => {
    if (!active || !isInActive(deepTarget(event))) return;
    setTimeout(() => quickNote('input', 'insertFromPaste'), 0);
  };
  on(document, 'paste', notePaste, true);
  on(document, 'drop', notePaste, true);

  on(document, 'mousemove', (event) => {
    if (!active || !enabled()) return;
    pointer = { x: event.clientX, y: event.clientY };
    const hit = overlay.hitTest(pointer.x, pointer.y, 2);
    if (hit) {
      clearTimeout(hideTimer);
      if (overlay.cardIssueRef() === hit.issue) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        overlay.showCard({
          issue: hit.issue,
          rect: hit.rect,
          canAddWord: hit.issue.category === 'spelling',
          handlers: cardHandlers,
        });
      }, HOVER_DELAY);
      return;
    }
    clearTimeout(hoverTimer);
    if (!overlay.isCardOpen() || overlay.isCardSticky()) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!overlay.isCardHovered()) overlay.hideCard();
    }, HIDE_GRACE);
  }, { passive: true, capture: true });

  on(document, 'mousedown', (event) => {
    if (!active || !enabled()) return;
    const hit = overlay.hitTest(event.clientX, event.clientY, 2);
    if (hit) {
      overlay.showCard({
        issue: hit.issue,
        rect: hit.rect,
        sticky: true,
        canAddWord: hit.issue.category === 'spelling',
        handlers: cardHandlers,
      });
      return;
    }
    if (overlay.isCardSticky() && !overlay.isCardHovered()) overlay.hideCard();
    if (overlay.isPanelOpen() && !overlay.panelContains(deepTarget(event))) overlay.hidePanel();
  }, true);

  on(document, 'keydown', (event) => {
    if (event.key === 'Escape') {
      if (overlay.isCardOpen() || overlay.isPanelOpen()) {
        overlay.hideCard();
        overlay.hidePanel();
      }
    }
  }, true);

  // A site can rewrite a field's value without an input event - a draft
  // restored, a template inserted. Nothing tells us, so look now and then.
  setInterval(() => {
    heal();
    if (!enabled()) return;
    if (!active) {
      // Focus can land in an editor without a focus event reaching us - a
      // site moving it there by script while it rebuilt the page.
      if (!document.hasFocus()) return;
      const el = focusedElement();
      if (el && NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
      return;
    }
    const adapter = active.adapter;
    if (!adapter.element.isConnected) { teardown(); return; }
    const now = adapter.getText().slice(0, MAX_CHARS);
    if (now !== active.text) scheduleCheck();
  }, 2000);

  on(window, 'scroll', reposition, { passive: true, capture: true });
  on(window, 'resize', reposition, { passive: true });
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', reposition);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'settings-changed') {
      loadSettings().then(() => {
        if (!enabled()) { teardown(); return; }
        if (active) {
          if (settings.quietOthers === false) restoreNative(active.adapter.element);
          else quietNative(active.adapter.element);
        }
        lastAiText = null;
        // A new limit, or the quick check switched back on: ask again now
        // rather than waiting out a pause from before.
        quickBlockedUntil = 0;
        if (active && quickOn() && !quickSkipsField(active.adapter)) quickFor(active.adapter);
        if (active) scheduleCheck({ immediate: true });
        else {
          const el = document.activeElement;
          if (el && NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
        }
      });
    } else if (message.type === 'command') {
      if (!active || !enabled()) return;
      if (message.name === 'show-suggestions') {
        const caret = active.adapter.caret();
        const entries = active.entries || [];
        const at = caret === null ? null : entries.find((e) => caret >= e.issue.start && caret <= e.issue.end);
        if (at) {
          overlay.showCard({
            issue: at.issue,
            rect: at.rects[0],
            sticky: true,
            canAddWord: at.issue.category === 'spelling',
            handlers: cardHandlers,
          });
        } else {
          openPanel();
        }
      } else if (message.name === 'check-now') {
        runAiNow();
      }
    } else if (message.type === 'ping') {
      respond({ ok: true, active: !!active, issues: active ? (active.issues || []).length : 0 });
      return true;
    }
    return undefined;
  });

  loadSettings().then((ok) => {
    if (!ok || !enabled()) return;
    const el = document.activeElement;
    if (el && NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
  });
})();
