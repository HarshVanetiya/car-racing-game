import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, everything else from /.
// The deploy workflow sets APEX_BASE; locally and on a single-service host it
// stays at the root.
const base = process.env.APEX_BASE || '/';

export default defineConfig({
  root: '.',
  base,
  server: {
    port: 5173,
    host: true,
    proxy: {
      // WebSocket signalling / race server
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1600
  }
});
