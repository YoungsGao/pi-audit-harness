import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-chains-test/main',
      rollupOptions: { input: resolve('tests/chains-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-chains-test/preload' } },
  renderer: { build: { outDir: 'out-chains-test/renderer' }, plugins: [react()] }
})
