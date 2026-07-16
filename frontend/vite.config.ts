import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
