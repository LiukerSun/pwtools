import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reactScreenshotsStyles } from './build/reactScreenshotsStyles';

export default defineConfig({
  root: resolve('src/renderer'),
  envDir: resolve('.'),
  plugins: [react(), reactScreenshotsStyles()],
  server: { host: 'localhost', port: 5173, strictPort: true },
});
