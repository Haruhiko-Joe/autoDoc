import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 8009,
    proxy: {
      '/api': process.env.BENCH_API_TARGET ?? 'http://localhost:3100',
    },
  },
})
