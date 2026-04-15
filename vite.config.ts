import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: "dist/public",
    emptyOutDir: true
  },
  server: {
    proxy: {
      // WebSocket proxy para o backend local em desenvolvimento
      "/ws": {
        target: "ws://localhost:3000",
        ws: true
      }
    }
  }
});
