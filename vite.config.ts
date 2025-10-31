import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { ViteUserConfig } from "vitest/config";

import { nodeBuiltinImportPostprocess } from "./plugins/node-builtin-import-postprocess";

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    nodeBuiltinImportPostprocess(),
  ],
  // @ts-expect-error - vitest types
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary"],
    },
    environment: "edge-runtime",
    passWithNoTests: true,
  } satisfies ViteUserConfig["test"],
});
