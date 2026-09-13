import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // 'server' resolves only inside docker compose; override for host-local
  // dev via .env / environment: VITE_API_TARGET=http://localhost:8100
  const env = loadEnv(mode, '', 'VITE_');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      host: true,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: env.VITE_API_TARGET ?? 'http://server:8100',
          changeOrigin: true,
        },
      },
    },
  };
});
