import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      outDir: 'out-pi-probe/main',
      rollupOptions: { input: resolve('tests/electron-pi-probe.ts') }
    }
  },
  preload: { build: { outDir: 'out-pi-probe/preload' } },
  renderer: { build: { outDir: 'out-pi-probe/renderer' }, plugins: [react()] }
})
