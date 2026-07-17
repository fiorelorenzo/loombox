import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';

/**
 * Shared loombox ESLint flat config. Every package inherits this via the root
 * eslint.config.js (which re-exports it). Type-aware linting is intentionally
 * left off for speed; correctness is enforced by `tsc` in the typecheck step.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/.output/**',
      '**/coverage/**',
      '**/node_modules/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Svelte: eslint-plugin-svelte's flat/recommended already wires
  // svelte-eslint-parser onto **/*.svelte; we additionally point it at the
  // TS parser so `<script lang="ts">` blocks get type-aware-adjacent
  // (syntactic) linting consistent with the rest of the monorepo.
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      // `...tseslint.configs.recommended` above already turns base `no-undef`
      // off for `**/*.ts`/`**/*.tsx` (ambient/lib globals like DOM types are
      // svelte-check's job, per this file's top comment), but that config's
      // `files` glob never matches `.svelte`, so its `<script>` blocks kept
      // the plain `eslint:recommended` `no-undef: error` and flagged every
      // real DOM type (`KeyboardEvent`, `HTMLElement`, ...) as an unresolved
      // global. Same rationale, applied consistently to `.svelte` files too.
      'no-undef': 'off',
    },
  },
  prettier,
  ...svelte.configs['flat/prettier'],
);
