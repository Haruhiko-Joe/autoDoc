import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // @antv/component 的 esm 产物引用了未声明依赖 tslib,pnpm 严格布局下无法解析
      tslib: fileURLToPath(new URL('./node_modules/tslib/tslib.es6.mjs', import.meta.url)),
    },
  },
  server: {
    port: 8008,
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
})
