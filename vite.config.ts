import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";

export default defineConfig({
  plugins: [
    appEnvPlugin(),
    tanstackStart({
      customViteReactPlugin: true,
    }),
    react(),
    tsconfigPaths(),
    tailwindcss(),
    grokPwaPlugin(),
  ],
  server: {
    port: 3000,
  },
});
