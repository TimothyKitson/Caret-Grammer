// Flat config for `npm run lint`. Needs eslint installed (globally is fine).
const browser = {
  window: 'readonly', document: 'readonly', location: 'readonly',
  navigator: 'readonly', getComputedStyle: 'readonly', chrome: 'readonly',
  fetch: 'readonly', Response: 'readonly', URL: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', DecompressionStream: 'readonly',
  Event: 'readonly', InputEvent: 'readonly', ResizeObserver: 'readonly',
  MutationObserver: 'readonly', IntersectionObserver: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly', confirm: 'readonly', self: 'readonly',
  process: 'readonly', performance: 'readonly',
};

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
