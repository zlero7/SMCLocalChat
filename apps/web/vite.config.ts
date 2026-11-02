import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 중에는 /api 요청을 API 서버로 넘겨서 CORS/쿠키 문제 없이 같은 주소처럼 쓴다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:4000',
      },
    },
  },
});
