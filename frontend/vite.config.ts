import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base`: em PROD o studio e servido num SUBPATH do dominio do OS (ex.: /agente-video/studio/)
// via proxy nginx — assets e chamadas precisam desse prefixo, senao dao 404 no iframe. Em dev
// (raiz, localhost:5174) fica "/". No build de PROD: `VITE_BASE=/agente-video/studio/ npm run build`.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: {
    port: 5174,
    // Encaminha /api e os assets (uploads/projects) para o backend em dev
    proxy: {
      "/api": "http://localhost:3002",
      "/uploads": "http://localhost:3002",
      "/projects": "http://localhost:3002",
    },
  },
});
