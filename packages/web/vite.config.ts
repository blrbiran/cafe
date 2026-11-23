import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const daemon = process.env.CAFE_DAEMON ?? "http://127.0.0.1:4777";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: ".",
    rollupOptions: {
      output: {
        // Content-hashed names: the daemon can then mark them immutable for a year (#69), and an
        // upgrade changes the name the HTML points at instead of living on in a warm browser cache.
        entryFileNames: "[name]-[hash].js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name]-[hash].[ext]",
      },
    },
  },
  server: {
    proxy: {
      "/api": daemon,
      "/ws": { target: daemon, ws: true },
    },
  },
});
