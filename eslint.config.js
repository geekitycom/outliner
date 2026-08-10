import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  // One config for the whole workspace; globs are repo-root relative.
  {
    ignores: ['**/dist', '**/dist-demo', '**/node_modules', '.husky', '**/src-tauri/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Library, demo, and app source all run in the browser.
    files: ['packages/*/src/**/*.ts', 'packages/*/example/**/*.ts', 'apps/*/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Config files run in Node.
    files: ['**/*.config.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Tests run in jsdom (browser globals) via Vitest.
    files: ['packages/*/test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Playwright specs: node runner + browser globals inside page.evaluate.
    files: ['packages/*/e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    rules: {
      // eval() is banned; the one intentional use (runSelection) carries an
      // explicit eslint-disable with justification.
      'no-eval': 'error',
    },
  },
)
