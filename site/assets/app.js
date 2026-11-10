// Three small things: reveal on scroll, a border on the header once you move,
// and the typing demo in the hero. All of them no-ops under reduced motion,
// and the page reads fine with this file missing entirely.

const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------- reveals

const rising = document.querySelectorAll('.rise');
if (calm || !('IntersectionObserver' in window)) {
  for (const el of rising) el.classList.add('in');
} else {
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      seen.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  for (const el of rising) seen.observe(el);
}

// -------------------------------------------------------------- header

// Not `top`: that is already a global (window.top), and redeclaring it throws
// before anything else in this file runs.
const bar = document.querySelector('header.top');
if (bar) {
  const mark = () => bar.classList.toggle('stuck', window.scrollY > 4);
  mark();
  window.addEventListener('scroll', mark, { passive: true });
}

// ---------------------------------------------------------------- demo

// Types a sentence, underlines the three mistakes in it, then shows the card
// for one of them. Restarts when it has been off screen and comes back.
const field = document.getElementById('demo-field');

if (field) {
  const TEXT = 'Hi Mrs. Ellis, I recieved the premission slip and will defintely ';
  const MARKS = [
    { word: 'recieved', kind: 'sp' },
    { word: 'premission', kind: 'sp' },
    { word: 'defintely', kind: 'sp' },
  ];

  const finished = () => {
    field.textContent = '';
    let at = 0;
    for (const mark of MARKS) {
      const found = TEXT.indexOf(mark.word, at);
      if (found === -1) continue;
      field.append(TEXT.slice(at, found));
      const span = document.createElement('span');
      span.className = `u ${mark.kind}`;
      span.textContent = mark.word;
      field.appendChild(span);
      at = found + mark.word.length;
    }
    field.append(TEXT.slice(at));
    const caret = document.createElement('span');
    caret.className = 'caret-bar';
    field.appendChild(caret);

    const card = document.createElement('div');
    card.className = 'card-pop';
    card.innerHTML = '<b>Spelling</b>“recieved” is not in the dictionary.'
      + '<br><span class="fix">received</span>';
    field.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));
  };

  if (calm) {
    finished();
  } else {
    let timer = null;
    const run = () => {
      clearTimeout(timer);
      field.textContent = '';
      const caret = document.createElement('span');
      caret.className = 'caret-bar';
      field.appendChild(caret);
      let i = 0;
      const step = () => {
        if (i >= TEXT.length) { finished(); return; }
        caret.before(TEXT[i]);
        i += 1;
        // Vary the delay a little so it reads like a person, not a teleprinter.
        timer = setTimeout(step, TEXT[i - 1] === ' ' ? 60 : 28 + Math.random() * 34);
      };
      timer = setTimeout(step, 450);
    };

    if ('IntersectionObserver' in window) {
      let playing = false;
      new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !playing) { playing = true; run(); }
          else if (!entry.isIntersecting) { playing = false; clearTimeout(timer); }
        }
      }, { threshold: 0.4 }).observe(field);
    } else {
      run();
    }
  }
}
