import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Bind to 0.0.0.0 (not just localhost) so other devices on the same
  // WiFi — a friend's phone, say — can open this app at
  // http://<your-machine's-LAN-IP>:5173. Vite prints that URL on startup.
  server: {
    host: true,
  },
})
