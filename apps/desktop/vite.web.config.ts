import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve('src/renderer'),
  envDir: resolve('.'),
  plugins: [react()],
  server: { host: 'localhost', port: 5173, strictPort: true },
});
