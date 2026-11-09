// Reading, measuring and editing the three kinds of writable field on the web.
//
// The hard part is measuring. A textarea has no DOM inside it, so there is
// nothing to ask for the position of the fifth word. The trick is a mirror: an
// off-screen div wearing the field's exact typography, holding the same text.
// A Range over the mirror gives rectangles, which are then shifted onto the
// real field and clipped to its visible box.
//
// A contenteditable needs no mirror - its text nodes are right there - but it
// does need care: nothing here ever modifies the page's own DOM, because doing
// that breaks rich editors. Underlines are drawn in our own overlay, and edits
// go through execCommand so the editor sees ordinary typing.

(() => {
  const NS = (window.__caret = window.__caret || {});
  if (NS.createAdapter) return;

  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'url', 'email', 'tel', '', 'textarea',
  ]);

  // Typography that changes where a character lands.
  const MIRRORED_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'fontStretch', 'fontKerning', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textAlign', 'lineHeight', 'direction',
    'tabSize', 'wordBreak', 'overflowWrap', 'whiteSpace', 'fontFeatureSettings',
    'fontVariationSettings', 'textRendering',
  ];

  function isElementVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  /** Should this element be checked at all? */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) {
      // Only the outermost editable host, so a nested span does not get its
      // own adapter on top of its parent's.
      return el.closest('[contenteditable="true"],[contenteditable=""]') === el
        || !el.parentElement?.closest('[contenteditable="true"],[contenteditable=""]');
    }
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (tag !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (!TEXT_INPUT_TYPES.has(type)) return false;
    if (el.readOnly || el.disabled) return false;
    if (getComputedStyle(el).webkitTextSecurity && getComputedStyle(el).webkitTextSecurity !== 'none') return false;
    return true;
  }

  /** Fields nobody wants a grammar checker in. */
  // Remembered for the lifetime of the page: sites swap type="password" to
  // type="text" behind a "reveal" button, and the field must stay excluded.
  const everSecret = new WeakSet();

  function rememberIfSecret(el) {
    if (!el || el.tagName !== 'INPUT') return;
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') everSecret.add(el);
  }

  function isOptedOut(el) {
    if (!el) return true;
    rememberIfSecret(el);
    if (everSecret.has(el)) return true;
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    if (type === 'password') return true;
    const autocomplete = (el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/.test(autocomplete)) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    // Honour the attributes sites already use to turn Grammarly off, plus ours.
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.dataset) {
        if (node.dataset.gramm === 'false') return true;
        if (node.dataset.enableGrammarly === 'false') return true;
        if (node.dataset.caret === 'off' || node.dataset.caret === 'false') return true;
      }
      // Grammarly's own attribute spells it with an underscore, which is not
      // the same key as dataset.grammEditor.
      if (node.getAttribute && node.getAttribute('data-gramm_editor') === 'false') return true;
      if (node.getAttribute && node.getAttribute('spellcheck') === 'false'
          && node.getAttribute('data-respect-spellcheck') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }

  function intersect(rect, clip) {
    const left = Math.max(rect.left, clip.left);
    const right = Math.min(rect.right, clip.right);
    const top = Math.max(rect.top, clip.top);
    const bottom = Math.min(rect.bottom, clip.bottom);
    if (right <= left + 0.5 || bottom <= top + 0.5) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /** Every ancestor that can clip the field, so underlines stay inside them. */
  function clippingRects(el) {
    const rects = [];
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) {
        rects.push(node.getBoundingClientRect());
      }
      node = node.parentElement;
    }
    rects.push({
      left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
    });
    return rects;
  }

  function scrollParents(el) {
    const parents = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(style.overflow + style.overflowX + style.overflowY)) {
        parents.push(node);
      }
      node = node.parentElement;
    }
    return parents;
  }

  // -------------------------------------------------------------------------
  // input and textarea
  // -------------------------------------------------------------------------

  function createTextFieldAdapter(el, mirrorHost) {
    const isTextarea = el.tagName === 'TEXTAREA';
    let mirror = null;
    let mirrorText = null;

    function ensureMirror() {
      if (mirror && mirror.isConnected) return mirror;
      mirror = document.createElement('div');
      mirror.className = 'gc-mirror';
      mirrorText = document.createTextNode('');
      mirror.appendChild(mirrorText);
      mirrorHost.appendChild(mirror);
      return mirror;
    }

    function syncMirror() {
      const node = ensureMirror();
      const style = getComputedStyle(el);
      const css = node.style;
      css.cssText = '';
      css.position = 'absolute';
      css.top = '0px';
      css.left = '0px';
      css.visibility = 'hidden';
      css.pointerEvents = 'none';
      css.margin = '0';
      css.border = '0';
      css.padding = '0';
      css.boxSizing = 'content-box';
      css.overflow = 'hidden';
      css.transform = 'none';
      for (const name of MIRRORED_STYLES) css[name] = style[name];
      if (isTextarea) {
        css.whiteSpace = el.wrap === 'off' ? 'pre' : 'pre-wrap';
        css.overflowWrap = style.overflowWrap === 'normal' ? 'break-word' : style.overflowWrap;
      } else {
        css.whiteSpace = 'pre';
      }
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const contentWidth = Math.max(0, el.clientWidth - paddingLeft - paddingRight);
      css.width = `${contentWidth}px`;
      if (!isTextarea) css.width = 'max-content';
      const value = el.value || '';
      if (mirrorText.nodeValue !== value) mirrorText.nodeValue = value;
      return { node, style, contentWidth };
    }

    /** Where the first character of the field's text actually sits on screen. */
    function geometry(style, textWidth) {
      const rect = el.getBoundingClientRect();
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const contentLeft = rect.left + borderLeft + paddingLeft;
      let textLeft = contentLeft - el.scrollLeft;
      let contentTop = rect.top + borderTop + paddingTop;
      if (!isTextarea) {
        // A single-line input centres its text vertically in the content box,
        // and - because the mirror is shrink-to-fit - alignment has to be
        // applied by hand. A textarea's mirror is the same width as the field,
        // so its own text-align already did the work.
        const contentHeight = el.clientHeight - paddingTop - paddingBottom;
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
        contentTop += Math.max(0, (contentHeight - lineHeight) / 2);
        const contentWidth = Math.max(0, el.clientWidth - paddingLeft - paddingRight);
        const rtl = style.direction === 'rtl';
        const align = style.textAlign;
        let factor = 0;
        if (align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)) factor = 1;
        else if (align === 'center') factor = 0.5;
        else if (rtl && (align === 'left' || align === 'start')) factor = 0;
        if (factor) textLeft += Math.max(0, contentWidth - (textWidth || 0)) * factor;
      }
      return { rect, contentLeft, textLeft, contentTop, style };
    }

    // Everything one measuring pass needs, worked out once. Without this, a
    // field with fifty issues rewrote the mirror's styles fifty times per
    // repaint - a style recalculation each time.
    let pass = null;

    function clipFor(style) {
      const rect = el.getBoundingClientRect();
      const clips = clippingRects(el);
      let clip = intersect(
        {
          left: rect.left + (parseFloat(style.borderLeftWidth) || 0),
          top: rect.top + (parseFloat(style.borderTopWidth) || 0),
          right: rect.right - (parseFloat(style.borderRightWidth) || 0),
          bottom: rect.bottom - (parseFloat(style.borderBottomWidth) || 0),
        },
        clips[clips.length - 1],
      );
      for (const other of clips) {
        if (!clip) return null;
        clip = intersect(clip, other);
      }
      return clip;
    }

    function measurePass() {
      if (pass && pass.value === (el.value || '')) return pass;
      const { node } = syncMirror();
      const textNode = node.firstChild;
      if (!textNode) return null;
      const style = getComputedStyle(el);
      const mirrorRect = node.getBoundingClientRect();
      pass = {
        value: el.value || '',
        textNode,
        mirrorRect,
        geo: geometry(style, mirrorRect.width),
        clip: clipFor(style),
      };
      return pass;
    }

    return {
      element: el,
      kind: isTextarea ? 'textarea' : 'input',

      getText() {
        return el.value || '';
      },

      /** Call once before a batch of rectsFor() calls. */
      invalidate() {
        pass = null;
      },

      isVisible() {
        return isElementVisible(el);
      },

      caret() {
        try {
          return el.selectionStart;
        } catch (_) {
          return null;
        }
      },

      rectsFor(start, end) {
        const value = el.value || '';
        if (start >= end || end > value.length) return [];
        const measured = measurePass();
        if (!measured || !measured.clip) return [];
        const { textNode, mirrorRect, geo, clip } = measured;
        const range = document.createRange();
        try {
          range.setStart(textNode, start);
          range.setEnd(textNode, end);
        } catch (_) {
          return [];
        }
        const out = [];
        for (const r of range.getClientRects()) {
          if (r.width === 0 && r.height === 0) continue;
          const moved = {
            left: geo.textLeft + (r.left - mirrorRect.left),
            top: geo.contentTop + (r.top - mirrorRect.top) - el.scrollTop,
            width: r.width,
            height: r.height,
          };
          moved.right = moved.left + moved.width;
          moved.bottom = moved.top + moved.height;
          const clipped = intersect(moved, clip);
          if (clipped) out.push(clipped);
        }
        return out;
      },

      replaceRange(start, end, replacement) {
        const value = el.value || '';
        if (end > value.length) return false;
        const selection = { start: el.selectionStart, end: el.selectionEnd };
        el.focus({ preventScroll: true });
        try {
          el.setSelectionRange(start, end);
        } catch (_) {
          return false;
        }
        let ok = false;
        try {
          ok = document.execCommand('insertText', false, replacement);
        } catch (_) {
          ok = false;
        }
        if (!ok) {
          // Frameworks track the value through the prototype setter, so use it
          // rather than assigning to el.value directly.
          const proto = el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const next = value.slice(0, start) + replacement + value.slice(end);
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        pass = null;
        const caret = start + replacement.length;
        const shift = replacement.length - (end - start);
        try {
          if (selection.start !== null && selection.start > end) {
            el.setSelectionRange(selection.start + shift, selection.end + shift);
          } else {
            el.setSelectionRange(caret, caret);
          }
        } catch (_) { /* detached */ }
        return true;
      },

      scrollTargets() {
        return [el, ...scrollParents(el)];
      },

      dispose() {
        if (mirror && mirror.parentNode) mirror.parentNode.removeChild(mirror);
        mirror = null;
        pass = null;
      },
    };
  }

  // -------------------------------------------------------------------------
  // contenteditable
  // -------------------------------------------------------------------------

  const BLOCK_DISPLAY = /^(block|flow-root|list-item|table|table-row|table-cell|flex|grid)/;

  function createEditableAdapter(el) {
    let segments = [];
    let cachedText = '';

    function build() {
      segments = [];
      let text = '';
      const push = (s) => { text += s; };
      const walk = (node) => {
        if (node.nodeType === 3) {
          const value = node.nodeValue || '';
          if (!value) return;
          segments.push({ node, from: text.length, length: value.length });
          push(value);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
        if (tag === 'BR') { push('\n'); return; }
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const block = BLOCK_DISPLAY.test(style.display);
        if (block && text.length && !text.endsWith('\n')) push('\n');
        for (const child of node.childNodes) walk(child);
        if (block && text.length && !text.endsWith('\n')) push('\n');
      };
      for (const child of el.childNodes) walk(child);
      cachedText = text;
      return text;
    }

    function locate(offset) {
      for (const segment of segments) {
        if (offset >= segment.from && offset <= segment.from + segment.length) {
          return { node: segment.node, offset: offset - segment.from };
        }
      }
      return null;
    }

    function makeRange(start, end) {
      const from = locate(start);
      const to = locate(end);
      if (!from || !to) return null;
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch (_) {
        return null;
      }
      return range;
    }

    return {
      element: el,
      kind: 'contenteditable',

      getText() {
        return build();
      },

      /** Call once before a batch of rectsFor() calls. */
      invalidate() {
        segments = [];
      },

      isVisible() {
        return isElementVisible(el);
      },

      caret() {
        const selection = document.getSelection();
        if (!selection || !selection.anchorNode || !el.contains(selection.anchorNode)) return null;
        for (const segment of segments) {
          if (segment.node === selection.anchorNode) return segment.from + selection.anchorOffset;
        }
        return null;
      },

      rectsFor(start, end) {
        if (!segments.length) build();
        if (start >= end || end > cachedText.length) return [];
        const range = makeRange(start, end);
        if (!range) return [];
        const clips = clippingRects(el);
        let clip = intersect(el.getBoundingClientRect(), clips[clips.length - 1]);
        if (!clip) return [];
        for (const other of clips) {
          clip = intersect(clip, other);
          if (!clip) return [];
        }
        const out = [];
        for (const r of range.getClientRects()) {
          if (r.width === 0 && r.height === 0) continue;
          const clipped = intersect(r, clip);
          if (clipped) out.push(clipped);
        }
        return out;
      },

      replaceRange(start, end, replacement, caretAt) {
        if (!segments.length) build();
        const range = makeRange(start, end);
        if (!range) return false;
        el.focus({ preventScroll: true });
        const selection = document.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        let ok = false;
        try {
          ok = document.execCommand('insertText', false, replacement);
        } catch (_) {
          ok = false;
        }
        if (!ok) {
          // Last resort. Rich editors dislike this, hence execCommand first.
          range.deleteContents();
          const node = document.createTextNode(replacement);
          range.insertNode(node);
          const after = document.createRange();
          after.setStart(node, node.length);
          after.collapse(true);
          selection.removeAllRanges();
          selection.addRange(after);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: replacement, inputType: 'insertText' }));
        }
        build();
        // Autocorrect fires while the user is still typing, so put the caret
        // back where their next keystroke belongs instead of after the fix.
        if (typeof caretAt === 'number') {
          const at = locate(Math.min(caretAt, cachedText.length));
          if (at) {
            const after = document.createRange();
            after.setStart(at.node, at.offset);
            after.collapse(true);
            selection.removeAllRanges();
            selection.addRange(after);
          }
        }
        return true;
      },

      scrollTargets() {
        return [el, ...scrollParents(el)];
      },

      dispose() {
        segments = [];
      },
    };
  }

  NS.isEditable = isEditable;
  NS.isOptedOut = isOptedOut;
  NS.rememberIfSecret = rememberIfSecret;
  NS.isElementVisible = isElementVisible;

  NS.createAdapter = function createAdapter(el, mirrorHost) {
    if (!isEditable(el) || isOptedOut(el)) return null;
    if (el.isContentEditable) return createEditableAdapter(el);
    return createTextFieldAdapter(el, mirrorHost);
  };
})();
