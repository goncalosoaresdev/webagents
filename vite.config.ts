import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const proxy = {
  '/api': 'http://127.0.0.1:8787',
  '/speech-ws': { target: 'ws://127.0.0.1:8787', ws: true },
  '/terminal-ws': { target: 'ws://127.0.0.1:8787', ws: true },
  '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy,
  },
});
