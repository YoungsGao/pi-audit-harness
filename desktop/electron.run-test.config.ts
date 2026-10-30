import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-run-test/main',
      rollupOptions: { input: resolve('tests/run-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-run-test/preload' } },
  renderer: { build: { outDir: 'out-run-test/renderer' }, plugins: [react()] }
})
