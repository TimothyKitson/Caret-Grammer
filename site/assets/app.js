// caretgrammar.com
//
// Everything in here is an extra. The pages are complete without this file:
// nothing is hidden in the markup or the stylesheet that only a script can
// show. Each part runs on its own, so one failing cannot take the others
// down with it, and all of it stands down under reduced motion.
//
// It is wrapped in a function on purpose. A top-level `const top` once threw
// here, because window.top already exists, and every scroll reveal on the
// site went with it.

(() => {
  'use strict';

  const root = document.documentElement;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canWatch = 'IntersectionObserver' in window;

  const part = (run) => {
    try { run(); } catch (err) { if (window.console) console.warn('caret site:', err); }
  };

  // Measuring text before the web fonts land gives the wrong answer, but a
  // slow font must not hold anything up for long either.
  const settled = document.fonts && document.fonts.ready
    ? Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, 1800))])
    : Promise.resolve();

  // -------------------------------------------------------------- header

  part(() => {
    const bar = document.querySelector('.nav');
    if (!bar) return;
    const mark = () => bar.classList.toggle('is-stuck', window.scrollY > 8);
    mark();
    window.addEventListener('scroll', mark, { passive: true });
  });

  // ------------------------------------------------------------- reveals

  // Only things below the fold are ever held back, and only by this script,
  // so anything already on screen never blinks and nothing can stay hidden
  // because a file failed to load.
  part(() => {
    if (calm || !canWatch) return;
    const waiting = Array.from(document.querySelectorAll('[data-reveal]'));
    if (!waiting.length) return;

    const arrive = (el, order) => {
      el.style.setProperty('--i', String(order));
      el.classList.remove('is-pending');
      el.classList.add('is-arriving');
      el.addEventListener('animationend', (event) => {
        if (event.target === el) el.classList.remove('is-arriving');
      });
    };

    const seen = new IntersectionObserver((entries) => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        seen.unobserve(entry.target);
        arrive(entry.target, order);
        order += 1;
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });

    const fold = window.innerHeight * 0.94;
    for (const el of waiting) {
      if (el.getBoundingClientRect().top < fold) continue;
      el.classList.add('is-pending');
      seen.observe(el);
    }
  });

  // ---------------------------------------------------------------- band

  // One row of corrections in the markup. Here it is laid end to end as
  // many times as the screen needs and set sliding; without this it is
  // simply a centred row.
  part(() => {
    const band = document.getElementById('band');
    if (!band || calm) return;
    const track = band.querySelector('.band-track');
    const first = band.querySelector('.band-row');
    if (!track || !first) return;

    const lay = () => {
      for (const copy of track.querySelectorAll('.band-row[aria-hidden]')) copy.remove();
      band.classList.add('is-sliding');
      const row = first.getBoundingClientRect().width;
      if (!row) { band.classList.remove('is-sliding'); return; }
      const copies = Math.ceil(band.clientWidth / row) + 1;
      for (let n = 0; n < copies; n += 1) {
        const copy = first.cloneNode(true);
        copy.setAttribute('aria-hidden', 'true');
        track.appendChild(copy);
      }
      band.style.setProperty('--band-shift', `${-row}px`);
      band.style.setProperty('--band-time', `${Math.max(18, Math.round(row / 34))}s`);
    };

    settled.then(() => part(lay));
    let width = window.innerWidth;
    let later = 0;
    window.addEventListener('resize', () => {
      clearTimeout(later);
      later = setTimeout(() => {
        if (window.innerWidth === width) return;
        width = window.innerWidth;
        part(lay);
      }, 200);
    });
  });

  // ---------------------------------------------------------------- demo

  // The hero text box. It types the sentence, an underline draws itself
  // under each mistake as the word is finished, then the pointer visits each
  // one: the card opens, the fix is clicked, the right word lands in a flash
  // of mint. Then it rests, clears and starts again.
  //
  // The sentence, the card text and the fixes are all read off the markup,
  // which is also what shows when this never runs.
  part(() => {
    const demo = document.getElementById('demo');
    const body = document.getElementById('demo-body');
    const text = document.getElementById('demo-text');
    const card = document.getElementById('demo-card');
    const badge = document.getElementById('demo-badge');
    const toggle = document.getElementById('demo-toggle');
    if (!demo || !body || !text || !card || !badge || calm) return;

    const KINDS = ['sp', 'gr', 'pu', 'cl'];
    const script = Array.from(text.childNodes).map((node) => {
      if (node.nodeType !== 1) return node.textContent;
      return {
        bad: node.textContent,
        good: node.dataset.fix || node.textContent,
        alt: node.dataset.alt || '',
        kind: KINDS.find((kind) => node.classList.contains(kind)) || 'sp',
        chip: node.dataset.chip || '',
        msg: node.dataset.msg || '',
        dict: 'dict' in node.dataset,
      };
    });
    const issues = script.filter((piece) => typeof piece !== 'string');
    if (!issues.length) return;
    const asShipped = text.innerHTML;

    const slots = {
      chip: card.querySelector('.chip'),
      msg: card.querySelector('.hcard-msg'),
      fixes: card.querySelector('.hcard-fixes'),
      add: card.querySelector('.add'),
    };
    if (!slots.chip || !slots.msg || !slots.fixes) return;

    const caret = document.createElement('span');
    caret.className = 'caret';
    const pointer = document.createElement('span');
    pointer.className = 'demo-pointer';
    pointer.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M4 2.5v15.2l4.2-3.7 2.7 6 2.7-1.2-2.7-5.9h5.6L4 2.5z" fill="#fff" stroke="#0b0b12" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    const tick = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8.5 3.2 3.2L13 4.6"/></svg>';

    // ---- time that can be held

    let run = 0;        // bumped on every restart, so a stale run stops itself
    let held = false;   // the pause button
    let away = false;   // scrolled out of view
    const queue = [];
    const stopped = () => held || away || document.hidden;
    const resume = () => { while (queue.length && !stopped()) queue.shift()(); };
    const flush = () => { for (const next of queue.splice(0)) next(); };

    // Resolves true when it is time to carry on, false when this run has
    // been replaced and should simply stop.
    const wait = (ms) => new Promise((resolve) => {
      const mine = run;
      const done = () => {
        if (mine !== run) { resolve(false); return; }
        if (stopped()) { queue.push(done); return; }
        resolve(true);
      };
      setTimeout(done, ms);
    });

    // ---- the pieces

    const setBadge = (count) => {
      badge.classList.toggle('clean', count === 0);
      if (count === 0) badge.innerHTML = tick; else badge.textContent = String(count);
      badge.classList.remove('pop');
      void badge.offsetWidth;
      badge.classList.add('pop');
    };

    const fillCard = (issue) => {
      slots.chip.className = `chip ${issue.kind}`;
      slots.chip.textContent = issue.chip;
      slots.msg.textContent = issue.msg;
      slots.fixes.textContent = '';
      [issue.good, issue.alt].filter(Boolean).forEach((word, i) => {
        const fix = document.createElement('span');
        fix.className = i ? 'fix alt' : 'fix';
        fix.textContent = word;
        slots.fixes.appendChild(fix);
      });
      if (slots.add) slots.add.hidden = !issue.dict;
    };

    // Where something is, measured from the corner of the text box.
    const where = (el) => {
      const box = el.getClientRects()[0] || el.getBoundingClientRect();
      const frame = body.getBoundingClientRect();
      return { left: box.left - frame.left, top: box.top - frame.top, width: box.width, height: box.height };
    };

    const pointAt = (el, across, down) => {
      const at = where(el);
      const x = at.left + at.width * across - 4;
      const y = at.top + at.height * down - 2;
      pointer.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };

    const openCard = (el) => {
      const at = where(el);
      const room = body.clientWidth - card.offsetWidth - 12;
      const left = Math.max(12, Math.min(at.left - 8, room));
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(at.top + at.height + 8)}px`;
      card.classList.add('show');
    };

    // ---- one pass

    const play = async () => {
      const mine = run;
      for (;;) {
        text.textContent = '';
        text.classList.remove('is-clearing');
        text.appendChild(caret);
        card.classList.remove('show');
        pointer.classList.remove('show');
        badge.classList.add('clean');
        badge.innerHTML = tick;
        if (!(await wait(700))) return;

        // type it
        const marked = [];
        let found = 0;
        for (const piece of script) {
          const issue = typeof piece === 'string' ? null : piece;
          const letters = document.createTextNode('');
          let span = null;
          if (issue) {
            span = document.createElement('span');
            span.className = `u ${issue.kind}`;
            span.appendChild(letters);
            text.insertBefore(span, caret);
            marked.push({ el: span, issue });
          } else {
            text.insertBefore(letters, caret);
          }
          for (const letter of issue ? issue.bad : piece) {
            letters.appendData(letter);
            const gap = letter === ' ' ? 44 : (letter === '.' || letter === ',' ? 150 : 20 + Math.random() * 30);
            if (!(await wait(gap))) return;
          }
          if (issue) {
            // The underline arrives a beat after the word, as it really does.
            wait(300).then((ok) => {
              if (!ok || mine !== run || !span.isConnected) return;
              span.classList.add('on');
              found += 1;
              setBadge(found);
            });
          }
        }
        if (!(await wait(1000))) return;

        // fix them, one at a time
        let left = marked.length;
        for (const [n, { el, issue }] of marked.entries()) {
          const first = n === 0;
          el.classList.add('on');
          pointAt(el, 0.55, 0.6);
          pointer.classList.add('show');
          if (!(await wait(first ? 640 : 520))) return;
          el.classList.add('is-active');
          fillCard(issue);
          openCard(el);
          if (!(await wait(first ? 1500 : 950))) return;
          const fix = card.querySelector('.fix');
          pointAt(fix, 0.6, 0.55);
          if (!(await wait(560))) return;
          fix.classList.add('is-pressed');
          if (!(await wait(170))) return;

          card.classList.remove('show');
          const good = document.createElement('span');
          good.className = 'ok';
          good.textContent = issue.good;
          el.replaceWith(good);
          left -= 1;
          setBadge(left);
          if (!(await wait(first ? 900 : 700))) return;
        }

        pointer.classList.remove('show');
        if (!(await wait(3800))) return;
        text.classList.add('is-clearing');
        if (!(await wait(420))) return;
      }
    };

    // Put the page back as it shipped, measure it, then take over. The box
    // keeps the height of the finished state, so nothing below it moves
    // while the sentence is typed.
    const start = () => {
      run += 1;
      flush();
      demo.classList.remove('is-live');
      text.classList.remove('is-clearing');
      text.innerHTML = asShipped;
      fillCard(issues[0]);
      card.classList.remove('show');
      card.style.left = '';
      card.style.top = '';
      badge.classList.remove('clean', 'pop');
      badge.textContent = String(issues.length);
      body.style.minHeight = '';
      body.style.minHeight = `${Math.ceil(body.getBoundingClientRect().height)}px`;
      demo.classList.add('is-live');
      if (!pointer.isConnected) body.appendChild(pointer);
      play();
    };

    if (canWatch) {
      new IntersectionObserver((entries) => {
        away = !entries[entries.length - 1].isIntersecting;
        if (!away) resume();
      }, { threshold: 0.15 }).observe(demo);
    }
    document.addEventListener('visibilitychange', resume);

    if (toggle) {
      const label = toggle.querySelector('span');
      const name = () => {
        if (label) label.textContent = held ? 'Play' : 'Pause';
        toggle.setAttribute('aria-label', held ? 'Play the animations' : 'Pause the animations');
      };
      toggle.addEventListener('click', () => {
        held = !held;
        root.classList.toggle('is-paused', held);
        name();
        if (!held) resume();
      });
      name();
      toggle.hidden = false;
    }

    settled.then(() => part(start));
    let width = window.innerWidth;
    let later = 0;
    window.addEventListener('resize', () => {
      clearTimeout(later);
      later = setTimeout(() => {
        if (window.innerWidth === width) return;
        width = window.innerWidth;
        part(start);
      }, 250);
    });
  });

  // ------------------------------------------------ the guide's contents

  part(() => {
    const links = Array.from(document.querySelectorAll('.toc a[href^="#"]'));
    if (!links.length) return;
    const stops = [];
    for (const link of links) {
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (target) stops.push({ link, target });
    }
    if (!stops.length) return;

    let here = null;
    const find = () => {
      let now = stops[0];
      for (const stop of stops) {
        if (stop.target.getBoundingClientRect().top <= 150) now = stop;
      }
      if (now.link === here) return;
      if (here) { here.classList.remove('is-here'); here.removeAttribute('aria-current'); }
      here = now.link;
      here.classList.add('is-here');
      here.setAttribute('aria-current', 'location');
    };

    let asked = false;
    window.addEventListener('scroll', () => {
      if (asked) return;
      asked = true;
      requestAnimationFrame(() => { asked = false; find(); });
    }, { passive: true });
    find();
  });

  // ------------------------------------------------------- page not found

  // Underline what was actually typed, if it is short enough to be funny.
  part(() => {
    const word = document.getElementById('lost-word');
    if (!word) return;
    const path = window.location.pathname;
    if (!/^\/[\x21-\x7e]{1,18}$/.test(path) || /^\/404(\.html)?$/.test(path)) return;
    word.textContent = path;
    if (word.parentElement) word.parentElement.classList.add('is-path');
  });
})();
