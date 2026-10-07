import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reactScreenshotsStyles } from './build/reactScreenshotsStyles';

export default defineConfig({
  root: resolve('src/renderer'),
  envDir: resolve('.'),
  plugins: [react(), reactScreenshotsStyles()],
  // The published stylesheet adapter must also run during development.
  optimizeDeps: { exclude: ['react-screenshots'] },
  server: { host: 'localhost', port: 5173, strictPort: true },
});
