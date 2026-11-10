import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-qa-test/main',
      rollupOptions: { input: resolve('tests/qa-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-qa-test/preload' } },
  renderer: { build: { outDir: 'out-qa-test/renderer' }, plugins: [react()] }
})
