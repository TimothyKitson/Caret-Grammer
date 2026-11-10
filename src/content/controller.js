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

  function scheduleCheck({ immediate = false, ai = false } = {}) {
    if (!enabled() || !active) return;
    clearTimeout(localTimer);
    localTimer = setTimeout(runCheck, immediate ? 0 : LOCAL_DELAY);
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
    });
    if (!response || mine !== version || !active || active.adapter !== adapter) return;
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

  function applyFixAt(adapter, start, end, fixed, caret) {
    const shift = fixed.length - (end - start);
    const ok = adapter.replaceRange(start, end, fixed, caret + shift);
    if (!ok) return false;
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

    const options = {
      autocorrect: settings.autocorrect,
      skip: refused,
      known: new Set(settings.customWords || []),
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
    const ok = adapter.replaceRange(issue.start, issue.end, replacement);
    overlay.hideCard();
    if (!ok) return;
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
    for (const issue of fixable) {
      const current = active.adapter.getText().slice(issue.start, issue.end);
      if (current !== issue.text) continue;
      active.adapter.replaceRange(issue.start, issue.end, issue.replacements[0]);
    }
    overlay.hidePanel();
    scheduleCheck({ immediate: true });
  }

  const cardHandlers = {
    onApply: applyFix,
    onAddWord: async (issue) => {
      overlay.hideCard();
      await send({ type: 'add-word', word: issue.text });
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
      handlers: {
        onApply: (issue, replacement) => { overlay.hidePanel(); applyFix(issue, replacement); },
        onFixAll: fixAll,
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
    el.setAttribute('spellcheck', 'false');
    // Chrome only re-reads spellcheck when the field is next focused, so a
    // field already focused keeps its squiggles until nudged.
    if (document.activeElement === el) {
      try {
        el.blur();
        el.focus({ preventScroll: true });
      } catch (_) { /* some editors refuse to be blurred */ }
    }
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

  document.addEventListener('focusin', (event) => {
    const el = deepTarget(event);
    // Do this before anything else: a field that is a password now must stay
    // excluded even if the site turns it into a text field later.
    if (NS.rememberIfSecret) NS.rememberIfSecret(el);
    if (NS.isEditable(el) && !NS.isOptedOut(el)) activate(el);
  }, true);

  document.addEventListener('input', (event) => {
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
      scheduleCheck();
    }
  }, true);

  document.addEventListener('mousemove', (event) => {
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

  document.addEventListener('mousedown', (event) => {
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

  document.addEventListener('keydown', (event) => {
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
    if (!active || !enabled()) return;
    const adapter = active.adapter;
    if (!adapter.element.isConnected) { teardown(); return; }
    const now = adapter.getText().slice(0, MAX_CHARS);
    if (now !== active.text) scheduleCheck();
  }, 2000);

  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });
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
        lastAiText = null;
        active.userEdited = true;      // asking for it is intent enough
        scheduleCheck({ immediate: true, ai: true });
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
