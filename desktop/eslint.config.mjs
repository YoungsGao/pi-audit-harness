import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/out-pi-probe',
      '**/out-test',
      '**/out-env02-test',
      '**/.env02-test-data',
      '**/.api01-test-data',
      '**/out-db01-test',
      '**/.db01-test-data',
      '**/.db02-test-data',
      '**/out-db02-test',
      '**/out-mod01-test',
      '**/.mod01-test-data',
      '**/out-source-test',
      '**/out-chains-test',
      '**/out-scan-test',
      '**/.scan-test-data',
      '**/.chains-test-data',
      '**/out-mod03-test',
      '**/.mod03-test-data',
      '**/out-templates-test',
      '**/.templates-test-data',
      '**/.review-test-data',
      '**/out-review-test',
      '**/out-run-test',
      '**/.run-test-data',
      '**/out-security-test',
      '**/.security-test-data',
      '**/out-qa-test',
      '**/.qa-test-data',
      '**/.reliability-test-data',
      '**/out-reliability-test',
      '**/resources/delivery/**'
    ]
  },
  tseslint.configs.recommended,
  {
    files: ['resources/codegraph-worker.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    files: [
      'tests/**/*.mjs',
      'scripts/query-*.mjs',
      'scripts/manual-lab*.mjs',
      'scripts/security-lab.mjs',
      'scripts/qa-*.mjs',
      'scripts/reliability-lab.mjs',
      'qa/**/*.mjs'
    ],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier
)
