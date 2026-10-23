import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-scan-test/main',
      rollupOptions: { input: resolve('tests/scan-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-scan-test/preload' } },
  renderer: { build: { outDir: 'out-scan-test/renderer' }, plugins: [react()] }
})
