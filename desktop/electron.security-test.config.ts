import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-security-test/main',
      rollupOptions: { input: resolve('tests/security-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-security-test/preload' } },
  renderer: { build: { outDir: 'out-security-test/renderer' }, plugins: [react()] }
})
