import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Ensure /share route falls back to index.html for Share Target
  appType: 'spa',
})
