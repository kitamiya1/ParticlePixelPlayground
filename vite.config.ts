import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 2 ページ構成：index.html = 描画方式の比較（浮き島）、aquarium.html = 水槽探検ゲーム
// `vite build --mode app`（npm run build:app）はアプリ版（Tauri）用：ゲームの aquarium.html だけを dist-app/ へ出す
export default defineConfig(({ mode }) => {
  const app = mode === 'app';
  const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  return {
    base: './',
    server: { port: 5173, open: false, strictPort: true },
    // Tauri の CLI が出す環境変数（TAURI_ENV_*）を import.meta.env から読めるようにする
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1200,
      outDir: app ? 'dist-app' : 'dist',
      rollupOptions: {
        input: app ? { aquarium: page('./aquarium.html') } : { main: page('./index.html'), aquarium: page('./aquarium.html') },
      },
    },
  };
});
