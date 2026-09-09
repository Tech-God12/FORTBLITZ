import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The Arena live preview proxies the sandbox under an *.e2b.app host,
    // so every host must be permitted or the dev server 403s the iframe.
    allowedHosts: true,
    cors: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['three'],
  },
});
