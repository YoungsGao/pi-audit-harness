import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-review-test/main',
      rollupOptions: { input: resolve('tests/review-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-review-test/preload' } },
  renderer: { build: { outDir: 'out-review-test/renderer' }, plugins: [react()] }
})
