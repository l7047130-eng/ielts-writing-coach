import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 后端端口固定 4100，避开 ielts-dashboard 的 4000
const API_TARGET = 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    open: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
