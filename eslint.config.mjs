/**
 * ESLint flat config for dsh-eteams.
 *
 * Strategy (per the team frontend standard): ESLint checks quality,
 * Prettier owns formatting — `eslint-config-prettier` disables every
 * stylistic rule that would fight the formatter. Naming conventions follow
 * the same standard: camelCase variables/functions, PascalCase
 * components/types, UPPER_SNAKE_CASE constants, camelCase filenames.
 *
 * @module eslint.config
 */
// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/.npm-cache/**',
      'docs/**',
      // Throwaway asar scanner (CJS, sandbox-only).
      '**/*.cjs',
      // 临时工作目录（文档缓存等，不入库）。
      '.tmp-*/**',
      // 任务 worktree（git 插件产物，独立检出，不参与主仓 lint）。
      '.dsh-worktrees/**',
    ],
  },

  // Quality base: JS recommended + TS recommended + no formatting rules.
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,

  // Browser plane: client bundle sources.
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Host plane and tests run on Node.
  {
    files: ['src/host/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Project-wide quality rules (formatting is Prettier's job, not ours).
  {
    plugins: { unicorn },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // camelCase filenames for every linted module; *.test.* keeps its dots.
      'unicorn/filename-case': ['error', { cases: { camelCase: true }, ignore: ['\\.test\\.'] }],
    },
  },

  // Build scripts and tool configs: Node globals, console allowed, filenames
  // follow each tool's own convention (eslint.config.mjs, tsdown.config.ts…).
  // Kept LAST on purpose: flat config is last-match-wins per rule, so this
  // override must come after the project-wide block above.
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs', 'tsdown.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      'unicorn/filename-case': 'off',
    },
  },

  // shadcn/ui vendored components (docs/21-client-ui-stack.md D19d): kebab-case
  // filenames are the upstream registry convention. Kept LAST on purpose:
  // flat config is last-match-wins per rule, so this must come after the
  // project-wide camelCase block above.
  {
    files: ['src/client/components/**'],
    rules: {
      'unicorn/filename-case': ['error', { cases: { kebabCase: true } }],
    },
  },
);
