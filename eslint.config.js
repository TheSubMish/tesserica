import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'src-tauri/', 'tests/golden/actual/'],
  },

  js.configs.recommended,
  tseslint.configs.recommended,
  // `configs.flat.*` — the top-level `configs['recommended-latest']` is still
  // the eslintrc-style object and ESLint 10 rejects its string plugin array.
  reactHooks.configs.flat['recommended-latest'],
  reactRefresh.configs.vite,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // The canvas and pipeline code is full of intentionally unused loop
      // bindings and `_`-prefixed placeholders for signatures that gain
      // parameters in later phases.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Node-side config files.
    files: ['*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
