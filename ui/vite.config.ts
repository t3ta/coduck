import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/jobs': 'http://localhost:3000',
      '/features': 'http://localhost:3000',
      '/worktrees': 'http://localhost:3000',
      '/events': 'http://localhost:3000',
    },
  },
});
