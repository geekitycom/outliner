import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist', 'dist-demo', 'node_modules', '.husky'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Library + demo source runs in the browser.
    files: ['src/**/*.ts', 'example/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Config files run in Node.
    files: ['*.config.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Tests run in jsdom (browser globals) via Vitest.
    files: ['test/**/*.ts'],
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
