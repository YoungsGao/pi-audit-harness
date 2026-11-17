import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      outDir: 'out-mcp-test/main',
      rollupOptions: { input: resolve('tests/mcp-electron-main.ts') }
    }
  },
  preload: { build: { outDir: 'out-mcp-test/preload' } },
  renderer: { build: { outDir: 'out-mcp-test/renderer' }, plugins: [react()] }
})
