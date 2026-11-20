import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { textCoreWasm } from "./scripts/textCoreWasm";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte(), textCoreWasm()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
});
