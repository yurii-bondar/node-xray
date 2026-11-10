import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `catch {}` and `_`-prefixed names are deliberate; everything else unused is a mistake.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Plain Node scripts: build scripts and the VS Code host test.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', require: 'readonly', module: 'writable', exports: 'writable', __dirname: 'readonly', fetch: 'readonly', setTimeout: 'readonly' },
    },
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // core runs in Node and in the browser: no Node built-ins, no DOM.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'core is isomorphic: inject Node APIs from the caller.' }] }],
    },
  },
);
