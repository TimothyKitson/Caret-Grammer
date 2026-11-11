// The word list, the frequency ranking, and the known-typo map, wrapped in the
// small API the spell checker and the rules need.
//
// Nothing here touches chrome.* or the network: the caller passes the raw text
// of the data files in. That keeps it testable in plain node.

export function createDictionary({
  wordsText = '',
  frequencyText = '',
  misspellings = {},
  properNounsText = '',
} = {}) {
  const words = new Set();
  for (const line of wordsText.split('\n')) {
    const w = line.trim();
    if (w) words.add(w);
  }

  const rank = new Map();
  {
    let i = 0;
    for (const line of frequencyText.split('\n')) {
      const w = line.trim();
      if (w && !rank.has(w)) rank.set(w, i += 1);
    }
  }

  // "Sarah" is always a name. "?Rose" is a name that is also an ordinary word,
  // so it only earns a capital when the sentence is clearly using it as one.
  const proper = new Map();
  for (const line of properNounsText.split('\n')) {
    const entry = line.trim();
    if (!entry) continue;
    const ambiguous = entry.startsWith('?');
    const form = ambiguous ? entry.slice(1) : entry;
    if (form) proper.set(form.toLowerCase(), { form, ambiguous });
  }

  const typos = new Map();
  for (const [bad, fixes] of Object.entries(misspellings)) {
    typos.set(bad, Array.isArray(fixes) ? fixes : [fixes]);
  }

  // Words the user added from the popup, plus words they told us to ignore.
  let userWords = new Set();
  // The ones they wrote with a capital - "Ignitia", "McDonald", "NASA" - and
  // the way they wrote it, so a lower-case "ignitia" can be given its capital.
  let userForms = new Map();

  const api = {
    size: words.size,

    setUserWords(list, softCaps = []) {
      userWords = new Set();
      userForms = new Map();
      const soft = new Set((softCaps || []).map((w) => String(w).toLowerCase()));
      for (const entry of list || []) {
        const form = String(entry || '').trim();
        if (!form) continue;
        const lower = form.toLowerCase();
        userWords.add(lower);
        if (form !== lower) {
          // A capital on an everyday word ("Will", "Grace") is a name only
          // some of the time, so it is treated like the built-in ambiguous
          // names: capitalized only where the sentence clearly means the name.
          // A name the built-in list already knows keeps its verdict
          // ("McDonald" is always a name, "Grace" only sometimes); only a
          // word new to Caret is judged by whether it is also an everyday word.
          const builtIn = proper.get(lower);
          userForms.set(lower, {
            form,
            ambiguous: builtIn
              ? builtIn.ambiguous
              : (soft.has(lower) || words.has(lower) || rank.has(lower)),
          });
        }
      }
    },

    /** Is this exactly a known word? (lower-cased input) */
    hasExact(word) {
      return words.has(word) || userWords.has(word);
    },

    /**
     * Is this word spelled correctly? Handles the forms a flat word list does
     * not carry: possessives ("Sarah's"), plural possessives ("teachers'"),
     * and contractions built on a known stem.
     */
    isKnown(word) {
      if (!word) return true;
      if (api.hasExact(word)) return true;
      const plain = word.replace(/’/g, "'");
      if (plain !== word && api.hasExact(plain)) return true;
      const apostrophe = plain.indexOf("'");
      if (apostrophe === -1) return false;
      const stem = plain.slice(0, apostrophe);
      const tail = plain.slice(apostrophe);
      if (!stem) return false;
      if (tail === "'s" || tail === "'") return api.hasExact(stem);   // dog's, teachers'
      if (tail === "n't") return api.hasExact(stem) || api.hasExact(`${stem}n't`);
      if (tail === "'ll" || tail === "'ve" || tail === "'re" || tail === "'d") {
        return api.hasExact(stem);
      }
      return false;
    },

    /** Lower is more common. Unknown words sort last. */
    rankOf(word) {
      return rank.get(word) || 1e9;
    },

    /** Known typo -> corrections, or null. */
    correctionsFor(word) {
      return typos.get(word) || null;
    },

    hasTypo(word) {
      return typos.has(word);
    },

    /**
     * The capitalized form of a name, or null.
     * @returns {{form: string, ambiguous: boolean}|null}
     */
    properForm(word) {
      return userForms.get(word) || proper.get(word) || null;
    },

    properCount: proper.size,

    typoCount: typos.size,
    frequencyCount: rank.size,
  };
  return api;
}
