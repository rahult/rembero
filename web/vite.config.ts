import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: new URL('./', import.meta.url).pathname,
  plugins: [react()],
  build: {
    outDir: '../dist/web-client',
    emptyOutDir: false,
  },
  server: {
    port: 4173,
    host: '127.0.0.1',
  },
});
