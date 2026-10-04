import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The backend listens on 127.0.0.1:8000. Use the IPv4 address explicitly: Node resolves
// "localhost" to ::1 first, which uvicorn does not listen on by default.
const BACKEND = "127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://${BACKEND}`,
      "/ws": { target: `ws://${BACKEND}`, ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
