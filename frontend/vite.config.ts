import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      // FastAPI backend: uvicorn backend.main:app --reload --port 8000
      '/api': 'http://localhost:8000',
    },
  },
});
