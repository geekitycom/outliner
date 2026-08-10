import { defineConfig } from 'vite'

// Standard Tauri v2 frontend config: the dev server must sit at a fixed,
// known port (1420) so src-tauri/tauri.conf.json's devUrl can point at it,
// and Tauri's own CLI output shouldn't be wiped by Vite clearing the screen.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
