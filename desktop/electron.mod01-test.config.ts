import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-mod01-test/main',
      rollupOptions: { input: resolve('tests/mod01-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-mod01-test/preload' } },
  renderer: { build: { outDir: 'out-mod01-test/renderer' }, plugins: [react()] }
})
