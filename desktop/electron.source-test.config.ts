import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-source-test/main',
      rollupOptions: { input: resolve('tests/source-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-source-test/preload' } },
  renderer: { build: { outDir: 'out-source-test/renderer' }, plugins: [react()] }
})
