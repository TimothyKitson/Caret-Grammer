// All of the extension's own UI, inside one closed shadow root so no page
// stylesheet can reach it and it cannot leak styles back out.
//
// Three pieces: the underline layer (never takes the mouse), the card that
// appears on hover, and the little count badge pinned to the field with the
// list of everything found.

(() => {
  const NS = (window.__caret = window.__caret || {});
  if (NS.createOverlay) return;

  const COLORS = {
    spelling: '#e5484d',
    grammar: '#2f6fd0',
    punctuation: '#8b5cf6',
    style: '#0f9b8e',
    advanced: '#0f9b8e',
  };

  const LABELS = {
    spelling: 'Spelling',
    grammar: 'Grammar',
    punctuation: 'Punctuation',
    style: 'Clarity',
    advanced: 'Clarity',
  };

  function squiggle(color) {
    const stroke = encodeURIComponent(color);
    return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='4'><path d='M0 3 Q 2 0.4 4 3 T 8 3' fill='none' stroke='${stroke}' stroke-width='1.4' stroke-linecap='round'/></svg>")`;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .layer, .mirrors { position: absolute; inset: 0; pointer-events: none; }
    .mirrors { overflow: hidden; height: 0; }
    /* Straight by default; .wavy on the layer switches to the squiggle. */
    .u {
      position: absolute;
      pointer-events: none;
      background-repeat: repeat-x;
      background-position: 0 100%;
      background-size: 8px 4px;
      border-bottom: 2px solid transparent;
      border-radius: 2px;
      transition: background-color 90ms linear;
    }
    .u.spelling { border-bottom-color: ${COLORS.spelling}; }
    .u.grammar { border-bottom-color: ${COLORS.grammar}; }
    .u.punctuation { border-bottom-color: ${COLORS.punctuation}; }
    .u.style, .u.advanced { border-bottom-color: ${COLORS.style}; }
    .layer.wavy .u { border-bottom-color: transparent; }
    .layer.wavy .u.spelling { background-image: ${squiggle(COLORS.spelling)}; }
    .layer.wavy .u.grammar { background-image: ${squiggle(COLORS.grammar)}; }
    .layer.wavy .u.punctuation { background-image: ${squiggle(COLORS.punctuation)}; }
    .layer.wavy .u.style, .layer.wavy .u.advanced { background-image: ${squiggle(COLORS.style)}; }
    .u.active.spelling { background-color: rgba(229, 72, 77, 0.13); }
    .u.active.grammar { background-color: rgba(47, 111, 208, 0.13); }
    .u.active.punctuation { background-color: rgba(139, 92, 246, 0.13); }
    .u.active.style, .u.active.advanced { background-color: rgba(15, 155, 142, 0.13); }

    .card, .panel {
      position: absolute;
      z-index: 2;
      pointer-events: auto;
      width: max-content;
      max-width: 320px;
      background: #ffffff;
      color: #1b1b1b;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
      padding: 12px 13px 10px;
      font-size: 13px;
      line-height: 1.45;
      animation: gc-in 110ms ease-out;
    }
    @keyframes gc-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; } }
    .head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
    .chip {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; padding: 2px 6px; border-radius: 5px;
      color: #fff; white-space: nowrap;
    }
    .chip.spelling { background: ${COLORS.spelling}; }
    .chip.grammar { background: ${COLORS.grammar}; }
    .chip.punctuation { background: ${COLORS.punctuation}; }
    .chip.style, .chip.advanced { background: ${COLORS.style}; }
    .src { font-size: 10.5px; color: #6b6b6b; margin-left: auto; white-space: nowrap; }
    .msg { margin: 0 0 9px; color: #2b2b2b; }
    .msg .was { text-decoration: line-through; text-decoration-color: #e5484d; }
    .fixes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
    button {
      font: inherit; cursor: pointer; border-radius: 7px; border: 1px solid transparent;
      padding: 5px 10px; background: #f1f3f6; color: #1b1b1b;
    }
    button.fix { font-weight: 600; background: #2f6fd0; color: #fff; }
    button.fix:hover { background: #255bb0; }
    button.fix.alt { background: #eef2f8; color: #1d4ea3; }
    button.fix.alt:hover { background: #e2e9f4; }
    button.fix.empty { font-style: italic; }
    .foot { display: flex; align-items: center; gap: 4px; border-top: 1px solid rgba(0,0,0,0.07);
            padding-top: 7px; margin-top: 2px; }
    button.link {
      background: none; border: none; padding: 3px 5px; color: #5e5e5e; font-size: 12px;
    }
    button.link:hover { color: #1b1b1b; background: #f3f4f6; }
    button.link.gear { margin-left: auto; font-size: 13px; }
    .panel { padding: 8px; max-width: 340px; }
    .panel h4 { margin: 4px 6px 8px; font-size: 12px; color: #5e5e5e; font-weight: 600;
                display: flex; align-items: center; gap: 6px; }
    .panel h4 button { margin-left: auto; padding: 3px 8px; font-size: 11.5px; }
    .row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; }
    .row:hover { background: #f5f7fa; }
    .row .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
    .row .dot.spelling { background: ${COLORS.spelling}; }
    .row .dot.grammar { background: ${COLORS.grammar}; }
    .row .dot.punctuation { background: ${COLORS.punctuation}; }
    .row .dot.style, .row .dot.advanced { background: ${COLORS.style}; }
    .row .what { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .what b { font-weight: 600; }
    .row button { padding: 3px 9px; font-size: 12px; }
    .empty-state { padding: 10px 8px; color: #5e5e5e; }
    .panel-ai { border-top: 1px solid rgba(0,0,0,0.07); margin-top: 6px; padding-top: 8px; }
    button.ai-check {
      display: flex; align-items: center; gap: 7px; width: 100%;
      padding: 7px 10px; border-radius: 8px; font-weight: 600; font-size: 12.5px;
      background: linear-gradient(135deg, #5b4bff, #4a39ea); color: #fff;
    }
    button.ai-check:hover { filter: brightness(1.07); }
    button.ai-check:disabled { cursor: default; opacity: .7; filter: none; }
    button.ai-check svg { width: 14px; height: 14px; flex: 0 0 auto; fill: currentColor; }
    button.ai-check .keys { margin-left: auto; font-weight: 500; font-size: 11px; opacity: .85; }

    .badge {
      position: absolute; z-index: 1; pointer-events: auto; cursor: pointer;
      min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
      background: #ffffff; color: #444; border: 1px solid rgba(0,0,0,0.12);
      box-shadow: 0 2px 8px rgba(0,0,0,0.14);
      font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 3px;
    }
    .badge.has { color: #b42318; border-color: rgba(229,72,77,0.45); }
    .badge.ai { color: #5b4bff; border-color: rgba(91,75,255,0.5); }
    .badge.ai::before {
      content: ""; width: 9px; height: 9px; border-radius: 50%;
      border: 2px solid rgba(91,75,255,0.25); border-top-color: #5b4bff;
      animation: gc-spin .8s linear infinite;
    }
    @keyframes gc-spin { to { transform: rotate(360deg); } }
    .status {
      position: absolute; z-index: 1; pointer-events: none;
      display: flex; align-items: center; gap: 7px;
      max-width: 300px; padding: 4px 10px 4px 8px; border-radius: 999px;
      background: #ffffff; color: #2b2b2b; border: 1px solid rgba(0,0,0,0.12);
      box-shadow: 0 4px 14px rgba(0,0,0,0.16);
      font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      animation: gc-in 140ms ease-out;
    }
    .status .spin {
      flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid rgba(91,75,255,0.25); border-top-color: #5b4bff;
      animation: gc-spin .8s linear infinite;
    }
    .status .dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #0f9b8e; }
    .status.warn .dot { background: #d97706; }
    .status.bad .dot { background: #e5484d; }
    .status.fading { opacity: 0; transition: opacity .4s ease; }
    @media (prefers-reduced-motion: reduce) {
      .badge.ai::before, .status .spin { animation-duration: 2.4s; }
    }
    .badge.clean { color: #0f9b8e; }
    .badge.busy { color: #6b6b6b; }
    .badge:hover { box-shadow: 0 3px 12px rgba(0,0,0,0.22); }
    [hidden] { display: none !important; }

    @media (prefers-color-scheme: dark) {
      .card, .panel, .badge, .status {
        background: #23262b; color: #ececec; border-color: rgba(255,255,255,0.12);
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      }
      .badge.ai { color: #a79fff; }
      .msg { color: #dcdcdc; }
      .src, button.link, .panel h4, .empty-state { color: #a8a8a8; }
      button { background: #32363d; color: #ececec; }
      button.link:hover { color: #fff; background: #3a3f47; }
      button.fix.alt { background: #2c3a52; color: #cfe0ff; }
      .row:hover { background: #2c3038; }
      .foot, .panel-ai { border-top-color: rgba(255,255,255,0.1); }
      button.ai-check { background: linear-gradient(135deg, #5b4bff, #4a39ea); color: #fff; }
    }
  `;

  function createOverlay() {
    const host = document.createElement('div');
    host.setAttribute('data-caret', 'ui');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;'
      + 'border:0;pointer-events:none;z-index:2147483646;';
    // Open, not closed: page CSS still cannot reach in (everything here is
    // set explicitly under `all: initial`), and being able to inspect the
    // overlay in devtools - and drive it from a test - is worth more.
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;';
    const layer = document.createElement('div');
    layer.className = 'layer';
    const mirrors = document.createElement('div');
    mirrors.className = 'mirrors';
    stage.append(layer, mirrors);
    root.append(style, stage);

    const pool = [];
    let drawn = [];
    let card = null;
    let cardIssue = null;
    let cardSticky = false;
    let cardHovered = false;
    let badge = null;
    let panel = null;
    let status = null;

    let attachedOnce = false;
    function attach() {
      if (host.isConnected) return;
      if (attachedOnce) {
        // The page rewrote its document (document.open), which also stripped
        // the listeners off the badge, card and panel. Throw them away so the
        // next draw builds fresh ones that work.
        for (const el of [card, badge, panel, status]) if (el) el.remove();
        card = null;
        badge = null;
        panel = null;
        status = null;
        cardIssue = null;
        cardSticky = false;
        cardHovered = false;
      }
      attachedOnce = true;
      // <html>, not <body>: a transform or filter on an ancestor makes
      // position: fixed relative to that ancestor instead of the viewport,
      // and some sites do that to <body> for page transitions.
      (document.documentElement || document.body).appendChild(host);
    }

    function takeUnderline(index) {
      let el = pool[index];
      if (!el) {
        el = document.createElement('div');
        pool[index] = el;
        layer.appendChild(el);
      }
      return el;
    }

    function placeFloating(el, rect, gap = 8) {
      // Measure first, then choose a side that fits.
      el.style.left = '0px';
      el.style.top = '0px';
      el.hidden = false;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      let left = Math.min(Math.max(8, rect.left - 6), Math.max(8, window.innerWidth - width - 8));
      let top = rect.bottom + gap;
      if (top + height > window.innerHeight - 8) {
        const above = rect.top - height - gap;
        top = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
      }
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    }

    const api = {
      mirrorHost: mirrors,

      /** 'straight' (default) or 'wavy'. */
      setUnderlineStyle(style) {
        layer.classList.toggle('wavy', style === 'wavy');
      },

      /** entries: [{issue, rects}] - all coordinates are viewport pixels. */
      drawUnderlines(entries) {
        attach();
        drawn = [];
        let index = 0;
        for (const entry of entries) {
          for (const rect of entry.rects) {
            if (index > 600) break;
            const el = takeUnderline(index);
            index += 1;
            el.className = `u ${entry.issue.category}`;
            el.hidden = false;
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.width = `${Math.max(2, rect.width)}px`;
            el.style.height = `${Math.max(6, rect.height)}px`;
            drawn.push({ issue: entry.issue, rect, el });
          }
        }
        for (let i = index; i < pool.length; i += 1) pool[i].hidden = true;
        if (cardIssue) api.markActive(cardIssue);
      },

      clearUnderlines() {
        for (const el of pool) el.hidden = true;
        drawn = [];
      },

      /** Topmost drawn issue under a point, or null. */
      hitTest(x, y, slack = 1) {
        let best = null;
        for (const item of drawn) {
          const r = item.rect;
          if (x >= r.left - slack && x <= r.left + r.width + slack
              && y >= r.top - slack && y <= r.top + r.height + slack) {
            if (!best || (r.width * r.height) < (best.rect.width * best.rect.height)) best = item;
          }
        }
        return best;
      },

      markActive(issue) {
        for (const item of drawn) {
          item.el.classList.toggle('active', !!issue && item.issue === issue);
        }
      },

      isCardOpen() { return !!card && !card.hidden; },
      isCardSticky() { return cardSticky; },
      isCardHovered() { return cardHovered; },
      cardIssueRef() { return cardIssue; },

      showCard({ issue, rect, sticky = false, canAddWord = false, handlers = {} }) {
        attach();
        if (!card) {
          card = document.createElement('div');
          card.className = 'card';
          card.addEventListener('mouseenter', () => { cardHovered = true; });
          card.addEventListener('mouseleave', () => { cardHovered = false; });
          // Keep the caret in the field: never let a click move focus.
          card.addEventListener('mousedown', (e) => e.preventDefault());
          stage.appendChild(card);
        }
        cardIssue = issue;
        cardSticky = sticky;
        card.textContent = '';

        const head = document.createElement('div');
        head.className = 'head';
        const chip = document.createElement('span');
        chip.className = `chip ${issue.category}`;
        chip.textContent = issue.short || LABELS[issue.category] || 'Suggestion';
        head.appendChild(chip);
        if (issue.source === 'ai') {
          const src = document.createElement('span');
          src.className = 'src';
          src.textContent = 'found by AI';
          head.appendChild(src);
        }
        card.appendChild(head);

        const msg = document.createElement('p');
        msg.className = 'msg';
        msg.textContent = issue.message || '';
        card.appendChild(msg);

        if (issue.replacements && issue.replacements.length) {
          const fixes = document.createElement('div');
          fixes.className = 'fixes';
          issue.replacements.slice(0, 5).forEach((replacement, i) => {
            const button = document.createElement('button');
            button.className = `fix${i ? ' alt' : ''}${replacement === '' ? ' empty' : ''}`;
            button.textContent = replacement === '' ? 'remove' : replacement;
            button.title = replacement === '' ? 'Delete the highlighted text' : `Replace with “${replacement}”`;
            button.addEventListener('click', () => handlers.onApply && handlers.onApply(issue, replacement));
            fixes.appendChild(button);
          });
          card.appendChild(fixes);
        }

        const foot = document.createElement('div');
        foot.className = 'foot';
        if (canAddWord) {
          const add = document.createElement('button');
          add.className = 'link';
          add.textContent = 'Add to dictionary';
          add.addEventListener('click', () => handlers.onAddWord && handlers.onAddWord(issue));
          foot.appendChild(add);
        }
        const ignore = document.createElement('button');
        ignore.className = 'link';
        ignore.textContent = 'Ignore';
        ignore.title = 'Stop reporting this here';
        ignore.addEventListener('click', () => handlers.onIgnore && handlers.onIgnore(issue));
        foot.appendChild(ignore);
        const gear = document.createElement('button');
        gear.className = 'link gear';
        gear.textContent = '⚙';
        gear.title = 'Caret settings';
        gear.addEventListener('click', () => handlers.onSettings && handlers.onSettings());
        foot.appendChild(gear);
        card.appendChild(foot);

        placeFloating(card, rect);
        api.markActive(issue);
      },

      hideCard() {
        if (card) card.hidden = true;
        cardIssue = null;
        cardSticky = false;
        cardHovered = false;
        api.markActive(null);
      },

      showBadge({ rect, count, state, handlers = {} }) {
        attach();
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'badge';
          badge.addEventListener('mousedown', (e) => e.preventDefault());
          badge.addEventListener('click', () => badge.__onClick && badge.__onClick());
          stage.appendChild(badge);
        }
        badge.__onClick = handlers.onClick;
        badge.hidden = false;
        badge.className = `badge ${state}`;
        badge.textContent = state === 'busy' ? '…' : state === 'ai' ? 'AI' : (count > 0 ? String(count) : '✓');
        badge.title = state === 'busy'
          ? 'Checking…'
          : state === 'ai'
            ? 'Checking with AI…'
            : (count > 0 ? `${count} suggestion${count === 1 ? '' : 's'} - click to list them` : 'No suggestions');
        const size = 20;
        const left = Math.min(rect.right - size - 6, window.innerWidth - size - 8);
        const top = Math.min(rect.bottom - size - 6, window.innerHeight - size - 8);
        badge.style.left = `${Math.round(Math.max(4, left))}px`;
        badge.style.top = `${Math.round(Math.max(4, top))}px`;
      },

      hideBadge() {
        if (badge) badge.hidden = true;
      },

      /**
       * A short line beside the badge saying what the AI check is doing:
       * working on it (busy), or how it went (tone: 'good', 'warn', 'bad').
       * Shown whether or not the badge is.
       */
      showStatus({ rect, text, busy = false, tone = 'good' }) {
        attach();
        if (!status) {
          status = document.createElement('div');
          status.setAttribute('role', 'status');
          stage.appendChild(status);
        }
        status.hidden = false;
        status.className = `status ${tone}`;
        status.textContent = '';
        const mark = document.createElement('span');
        mark.className = busy ? 'spin' : 'dot';
        const label = document.createElement('span');
        label.textContent = text;
        status.append(mark, label);
        // To the left of the badge, on its line, inside the viewport.
        const width = status.offsetWidth;
        const right = Math.min(rect.right - 32, window.innerWidth - 8);
        const left = Math.max(8, right - width);
        // Centred on the badge, which sits 6px in from the corner and is 20px tall.
        const top = Math.min(rect.bottom - 16 - status.offsetHeight / 2, window.innerHeight - status.offsetHeight - 8);
        status.style.left = `${Math.round(left)}px`;
        status.style.top = `${Math.round(Math.max(4, top))}px`;
      },

      fadeStatus() {
        if (status && !status.hidden) status.classList.add('fading');
      },

      hideStatus() {
        if (status) status.hidden = true;
      },

      badgeRect() {
        return badge && !badge.hidden ? badge.getBoundingClientRect() : null;
      },

      showPanel({ issues, rect, fixableCount, aiCheck = null, handlers = {} }) {
        attach();
        if (!panel) {
          panel = document.createElement('div');
          panel.className = 'panel';
          panel.addEventListener('mousedown', (e) => e.preventDefault());
          stage.appendChild(panel);
        }
        panel.textContent = '';
        const title = document.createElement('h4');
        title.textContent = issues.length
          ? `${issues.length} suggestion${issues.length === 1 ? '' : 's'}`
          : 'Nothing to fix';
        if (fixableCount > 1) {
          const all = document.createElement('button');
          all.textContent = `Fix all ${fixableCount}`;
          all.addEventListener('click', () => handlers.onFixAll && handlers.onFixAll());
          title.appendChild(all);
        }
        panel.appendChild(title);

        if (!issues.length) {
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = 'This field looks clean.';
          panel.appendChild(empty);
        }

        for (const issue of issues.slice(0, 14)) {
          const row = document.createElement('div');
          row.className = 'row';
          const dot = document.createElement('span');
          dot.className = `dot ${issue.category}`;
          row.appendChild(dot);
          const what = document.createElement('span');
          what.className = 'what';
          const strong = document.createElement('b');
          strong.textContent = issue.text.length > 28 ? `${issue.text.slice(0, 28)}…` : issue.text;
          what.append(strong, document.createTextNode(` — ${issue.short || ''}`));
          what.title = issue.message;
          row.appendChild(what);
          if (issue.replacements && issue.replacements.length) {
            const fix = document.createElement('button');
            const first = issue.replacements[0];
            fix.textContent = first === '' ? 'remove' : first;
            fix.title = `Replace with “${first}”`;
            fix.addEventListener('click', () => handlers.onApply && handlers.onApply(issue, first));
            row.appendChild(fix);
          }
          row.addEventListener('mouseenter', () => api.markActive(issue));
          row.addEventListener('mouseleave', () => api.markActive(null));
          panel.appendChild(row);
        }

        // The AI pass, from inside the page. Some sites replace the browser's
        // right-click menu with their own, which hides "Proofread with AI";
        // this is always here.
        if (aiCheck && handlers.onAiCheck) {
          const wrap = document.createElement('div');
          wrap.className = 'panel-ai';
          const go = document.createElement('button');
          go.className = 'ai-check';
          go.disabled = !!(aiCheck.busy || aiCheck.reason);
          const svgNS = 'http://www.w3.org/2000/svg';
          const icon = document.createElementNS(svgNS, 'svg');
          icon.setAttribute('viewBox', '0 0 16 16');
          icon.setAttribute('aria-hidden', 'true');
          const star = document.createElementNS(svgNS, 'path');
          star.setAttribute('d', 'M8 0l1.8 5.2L15 7l-5.2 1.8L8 14l-1.8-5.2L1 7l5.2-1.8z');
          icon.appendChild(star);
          const label = document.createElement('span');
          label.textContent = aiCheck.reason || (aiCheck.busy ? 'Checking…' : 'Check with AI');
          go.append(icon, label);
          if (aiCheck.keys && !aiCheck.reason) {
            const keys = document.createElement('span');
            keys.className = 'keys';
            keys.textContent = aiCheck.keys;
            go.appendChild(keys);
          }
          go.addEventListener('click', () => handlers.onAiCheck());
          wrap.appendChild(go);
          panel.appendChild(wrap);
        }
        placeFloating(panel, rect, 6);
      },

      hidePanel() {
        if (panel) panel.hidden = true;
      },

      isPanelOpen() { return !!panel && !panel.hidden; },

      panelContains(node) {
        return !!panel && !panel.hidden && (node === panel || panel.contains(node));
      },

      destroy() {
        if (host.parentNode) host.parentNode.removeChild(host);
      },
    };

    return api;
  }

  NS.createOverlay = createOverlay;
  NS.CATEGORY_LABELS = LABELS;
})();
