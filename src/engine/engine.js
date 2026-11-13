// Puts the checks together: spelling, the rule set, and (when it is switched
// on) whatever the Claude API sent back. Produces one clean list of issues,
// sorted by position, with overlaps resolved.

import { analyze } from './tokenize.js';
import { checkToken, resetDeepSearchBudget } from './spelling.js';
import { runRules } from './rules.js';

// When two findings cover the same words, the lower number wins.
const PRIORITY = {
  spelling: 1,
  grammar: 2,
  ai: 2.5,
  punctuation: 3,
  style: 4,
  advanced: 5,
};

const DEFAULT_MAX_ISSUES = 250;

function priorityOf(issue) {
  if (issue.source === 'ai') return PRIORITY.ai;
  return PRIORITY[issue.category] || 3;
}

function mergeReplacements(target, extra) {
  for (const replacement of extra) {
    if (replacement && !target.includes(replacement)) target.push(replacement);
  }
}

// A sentence problem covers a stretch of words, and the word-level mistakes
// inside it still need their own underlines. So sentence problems are kept
// on a layer of their own: they only compete with each other.
const MAX_SENTENCE_ISSUES = 12;

/** Resolve overlaps and identical spans. Returns issues sorted by position. */
export function reconcile(issues, maxIssues = DEFAULT_MAX_ISSUES) {
  const sentences = [];
  for (const issue of issues) {
    if (issue.category !== 'sentence') continue;
    if (sentences.some((s) => issue.start < s.end && s.start < issue.end)) continue;
    sentences.push(issue);
    if (sentences.length >= MAX_SENTENCE_ISSUES) break;
  }
  const words = reconcileWords(issues.filter((issue) => issue.category !== 'sentence'), maxIssues);
  return [...words, ...sentences].sort((a, b) => a.start - b.start || a.end - b.end);
}

function reconcileWords(issues, maxIssues) {
  const ordered = [...issues].sort((a, b) => {
    const p = priorityOf(a) - priorityOf(b);
    if (p !== 0) return p;
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });

  const kept = [];
  for (const issue of ordered) {
    let clash = null;
    for (const existing of kept) {
      if (issue.start < existing.end && existing.start < issue.end) { clash = existing; break; }
    }
    if (clash) {
      if (clash.start === issue.start && clash.end === issue.end) {
        mergeReplacements(clash.replacements, issue.replacements);
        if (!clash.alsoFlaggedBy) clash.alsoFlaggedBy = [];
        clash.alsoFlaggedBy.push(issue.id);
      }
      continue;
    }
    kept.push(issue);
    if (kept.length >= maxIssues) break;
  }

  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  return kept;
}

/**
 * @param {string} text the whole contents of the field
 * @param {object} deps {dict}
 * @param {object} options {categories, ignored:Set<string>, checkNames, maxIssues}
 * @param {object[]} extraIssues findings from the AI pass, already offset-mapped
 */
export function check(text, { dict }, options = {}, extraIssues = []) {
  const doc = analyze(text);
  const categories = options.categories || {};
  const issues = [];

  if (categories.spelling !== false && dict) {
    resetDeepSearchBudget(options.deepSearches || 12);
    for (const token of doc.tokens) {
      const issue = checkToken(token, dict, options, doc);
      if (issue) issues.push(issue);
    }
  }

  issues.push(...runRules(doc, { ...options, dict }));
  for (const issue of extraIssues) issues.push({ ...issue, source: 'ai' });

  const ignored = options.ignored;
  const filtered = ignored && ignored.size
    ? issues.filter((issue) => !ignored.has(ignoreKey(issue)))
    : issues;

  const kept = reconcile(filtered, options.maxIssues || DEFAULT_MAX_ISSUES);
  // Suggestions are written with plain apostrophes. If the writer is using
  // curly ones, hand back curly ones.
  if (text.includes('\u2019')) {
    for (const issue of kept) {
      issue.replacements = issue.replacements.map((r) => r.replace(/'/g, '\u2019'));
    }
  }
  return {
    issues: kept,
    stats: {
      words: doc.wordCount,
      sentences: doc.sentences.length,
      characters: text.length,
      byCategory: kept.reduce((acc, issue) => {
        acc[issue.category] = (acc[issue.category] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

/** Identifies "this exact complaint about this exact text" for the ignore list. */
export function ignoreKey(issue) {
  return `${issue.id}:${issue.text.toLowerCase()}`;
}

export { analyze } from './tokenize.js';
