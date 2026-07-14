import { defineConfig } from 'vite'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Library build (separate from the demo app in vite.config.ts). Emits:
//   dist/outliner.js         ESM bundle — the modern default (import/bundlers)
//   dist/outliner.global.js  self-contained IIFE exposing a global `Outliner`,
//                            for plain <script> drop-in use like classic Concord
//   dist/outliner.css        the stylesheet (link it alongside either build)
//   dist/*.d.ts              type declarations (emitted separately by tsc)
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(process.cwd(), 'src/index.ts'),
      name: 'Outliner', // global variable name for the IIFE build
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'outliner.js' : 'outliner.global.js'),
    },
  },
  plugins: [
    {
      // The stylesheet isn't imported by src/index.ts (so ESM consumers aren't
      // forced to inject it); ship it as a standalone file to link.
      name: 'copy-stylesheet',
      closeBundle() {
        copyFileSync(
          resolve(process.cwd(), 'src/styles.css'),
          resolve(process.cwd(), 'dist/outliner.css'),
        )
      },
    },
  ],
})
