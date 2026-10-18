import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite proxies /api to the Express server. This is the "dev-proxy trap": the app works locally
// because of this line, and a static export of dist/ silently loses it.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3001" } },
});
