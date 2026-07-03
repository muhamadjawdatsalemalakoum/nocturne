import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const port = Number(process.env.NOCTURNE_PORT ?? 5151);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@nocturne/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${port}`,
      "/ws": { target: `ws://localhost:${port}`, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
