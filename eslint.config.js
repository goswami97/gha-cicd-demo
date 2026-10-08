import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
};

const browserGlobals = {
  document: 'readonly',
  fetch: 'readonly',
  setInterval: 'readonly',
};

export default [
  { ignores: ['dist/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
];
