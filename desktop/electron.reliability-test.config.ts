import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-reliability-test/main',
      rollupOptions: { input: resolve('tests/reliability-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-reliability-test/preload' } },
  renderer: { build: { outDir: 'out-reliability-test/renderer' }, plugins: [react()] }
})
