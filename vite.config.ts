import type { PluginOption } from "vite";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { ViteUserConfig } from "vitest/config";

import { nodeBuiltinImportPostprocess } from "./plugins/node-builtin-import-postprocess";
const plugins: Array<PluginOption> = [];

plugins.push(tailwindcss());
if (process.env.VITEST !== "true")
  plugins.push(
    cloudflare({ experimental: { headersAndRedirectsDevModeSupport: true }, viteEnvironment: { name: "ssr" } }),
  );
plugins.push(tanstackStart());
plugins.push(viteReact());

plugins.push(nodeBuiltinImportPostprocess());

export default defineConfig({
  // build: { sourcemap: true },
  plugins,
  resolve: { tsconfigPaths: true },

  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary"],
    },
    environment: "edge-runtime",
    passWithNoTests: true,
  } satisfies ViteUserConfig["test"],
});
