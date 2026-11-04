import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API runs on :8787 (npm run dev in the repo root) and Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
});
