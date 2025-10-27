import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    alias: {
      '$lib': resolve('./src/lib'),
      '$app': resolve('./src/app'),
    },
    environment: 'jsdom',
    browser: {
      enabled: true,
      name: 'chromium',
      provider: 'playwright',
      headless: true,
    },
    include: ['src/**/*.spec.js'],
    exclude: ['e2e/**/*'],
  },
  resolve: {
    alias: {
      '$lib': resolve('./src/lib'),
      '$app': resolve('./src/app'),
    },
  },
});