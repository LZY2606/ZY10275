/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { tsReviewApi } from './src/server/plugin'

export default defineConfig({
  plugins: [tsReviewApi()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
