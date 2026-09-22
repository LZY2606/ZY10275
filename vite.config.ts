import { defineConfig, type Plugin } from 'vite';
import { reviewBenchApi } from './src/server/plugin.js';

export default defineConfig({
  plugins: [reviewBenchApi() as Plugin],
  server: { host: '127.0.0.1', port: 5975 },
  build: { target: 'es2022' },
});
