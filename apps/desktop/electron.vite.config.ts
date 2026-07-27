import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["electron", "@anthropic-ai/claude-agent-sdk", "@opencode-ai/sdk"] } },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    resolve: { alias: { "@renderer": resolve("src/renderer") } },
    plugins: [react()],
  },
});
