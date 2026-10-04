import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve('src/renderer'),
  // WebView2 serves the built assets at https://pwtools.local/.
  base: './',
  plugins: [
    react(),
    {
      name: 'native-content-security-policy',
      apply: 'build',
      transformIndexHtml: () => [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'",
        },
        injectTo: 'head-prepend',
      }],
    },
  ],
  server: { host: 'localhost', port: 5173, strictPort: true },
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/index.html') },
  },
});
