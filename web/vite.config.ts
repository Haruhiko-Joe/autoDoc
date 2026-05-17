import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 8008,
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
})
