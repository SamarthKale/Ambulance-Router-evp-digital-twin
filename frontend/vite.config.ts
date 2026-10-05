import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { deliveredModels } from "./scripts/deliveredModels.ts";

// The backend listens on 127.0.0.1:8000. Use the IPv4 address explicitly: Node resolves
// "localhost" to ::1 first, which uvicorn does not listen on by default.
const BACKEND = "127.0.0.1:8000";

export default defineConfig({
  // 3d_models/ (the team's deliveries, Git LFS) is served at /models/ unmodified
  plugins: [react(), deliveredModels("../3d_models")],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://${BACKEND}`,
      "/ws": { target: `ws://${BACKEND}`, ws: true },
    },
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
