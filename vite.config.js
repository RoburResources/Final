import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development Vite serves the UI and Express serves the API, so /api is
 * proxied across. In production Express serves dist/ itself and there is only
 * one origin — which is what WebAuthn and the microphone both want.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
