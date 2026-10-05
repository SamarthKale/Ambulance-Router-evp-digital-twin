import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { deliveredModels } from "./scripts/deliveredModels.ts";

// The backend listens on 127.0.0.1:8000. Use the IPv4 address explicitly: Node resolves
// "localhost" to ::1 first, which uvicorn does not listen on by default. start.ps1 sets
// EF_BACKEND when it runs the backend on another port.
const BACKEND = process.env.EF_BACKEND ?? "127.0.0.1:8000";
const proxy = {
  "/api": `http://${BACKEND}`,
  "/ws": { target: `ws://${BACKEND}`, ws: true },
};

export default defineConfig({
  // 3d_models/ (the team's deliveries, Git LFS) is served at /models/ unmodified
  plugins: [react(), deliveredModels("../3d_models")],
  server: { port: 5173, strictPort: true, proxy },
  // `npm run build` then `npm run preview` (start.ps1 -Prod): the production bundle, same proxy
  preview: { port: 4173, strictPort: true, proxy },
  optimizeDeps: {
    // Imported only by the skybox Web Worker, which the start-up dependency scan doesn't
    // follow. Undeclared, Vite discovers it ~10 s after the page opens, re-optimises and
    // force-reloads the page, cutting the live WebSocket ("ws proxy error: ECONNRESET").
    include: ["three/examples/jsm/loaders/EXRLoader.js"],
  },
  build: {
    // one page served locally: three.js + React + drei is ~1.3 MB (350 KB gzipped), on purpose
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
