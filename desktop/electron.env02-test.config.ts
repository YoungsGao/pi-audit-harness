import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      outDir: 'out-env02-test/main',
      rollupOptions: { input: resolve('tests/env02-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-env02-test/preload' } },
  renderer: { build: { outDir: 'out-env02-test/renderer' }, plugins: [react()] }
})
