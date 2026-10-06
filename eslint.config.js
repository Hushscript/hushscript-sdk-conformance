// @ts-check
import eslint from '@eslint/js';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'eslint/config';
import n from 'eslint-plugin-n';
import * as regexp from 'eslint-plugin-regexp';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['fixtures/**', 'node_modules/**'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  regexp.configs['flat/recommended'],
  n.configs['flat/recommended-module'],
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)) },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Type-checked JSDoc in .mjs files: the .d.ts holds the shared shapes.
      '@typescript-eslint/consistent-type-definitions': 'off',
      // Conflicts with noPropertyAccessFromIndexSignature.
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Tests read untyped JSON responses from the mock.
    files: ['mock/test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // node:test registers tests with a floating promise by design.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
