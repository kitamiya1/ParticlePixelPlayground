import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // 2 ページ構成：index.html = 描画方式の比較（浮き島）、aquarium.html = 水槽探検ゲーム
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        aquarium: fileURLToPath(new URL('./aquarium.html', import.meta.url)),
      },
    },
  },
});
