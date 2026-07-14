import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the built dist/index.html also works when opened
  // directly from disk (file://), not just when served over http.
  base: './',
  server: {
    port: 5174,
  },
})
