import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Second library pass: the legacy-Concord compatibility global. Appends to the
// dist/ produced by vite.lib.config.ts (emptyOutDir is false so it isn't wiped).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(process.cwd(), 'src/compat-global.ts'),
      name: 'Outliner',
      formats: ['iife'],
      fileName: () => 'outliner.compat.global.js',
    },
  },
})
