import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0' },
  build: { target: 'es2022', chunkSizeWarningLimit: 850 },
  worker: { format: 'es' },
});
