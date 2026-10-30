import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-templates-test/main',
      rollupOptions: { input: resolve('tests/templates-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-templates-test/preload' } },
  renderer: { build: { outDir: 'out-templates-test/renderer' }, plugins: [react()] }
})
