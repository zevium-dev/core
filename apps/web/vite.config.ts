import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    resolve: {
      tsconfigPaths: true,
      alias:
        env.VITE_CONTROL_PLANE_MODE === "next"
          ? [
              {
                find: "#/lib/convex-api",
                replacement: fileURLToPath(
                  new URL("./src/lib/convex-api.next.ts", import.meta.url),
                ),
              },
            ]
          : [],
    },
    build: { manifest: true, ssrManifest: true },
    plugins: [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      devtools(),
      tailwindcss(),
      tanstackStart({ server: { entry: "./server.ts" } }),
      viteReact(),
    ],
  };
});
