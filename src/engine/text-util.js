// Small helpers shared by the spell checker and the rules.

/** Give `replacement` the capitalization of `original`. */
export function matchCase(original, replacement) {
  if (!original || !replacement) return replacement;
  if (original.length > 1 && original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return replacement.toUpperCase();
  }
  if (/^[A-Z]/.test(original) && !/^[A-Z]/.test(replacement)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** "$1 have" + match -> "could have" */
export function fillTemplate(template, match) {
  return String(template).replace(/\$(\d)/g, (_, d) => match[Number(d)] || '');
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
