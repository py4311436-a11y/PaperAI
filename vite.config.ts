import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
  },
  // pdfjs-dist ships prebuilt ESM; avoid pre-bundling so worker + wasm resolve natively
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    // Source maps only for automation builds. A release map would (a) add
    // ~3.3 MiB to dist/, which tauri then embeds into the setup.exe, and
    // (b) publish the original TypeScript inside a distributed installer.
    // Automation builds are never shipped, so keeping maps there is useful
    // when a test fails and you need a real stack trace.
    sourcemap: process.env.VITE_PAPERAI_AUTOMATION === "1",
  },
});