import { resolve } from "node:path";
import { assertGeneratedFileFresh } from "./check-generated-routes.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const webRoot = resolve(repositoryRoot, "apps/web");

try {
  assertGeneratedFileFresh({
    cwd: webRoot,
    file: "src/routeTree.gen.ts",
    command: "pnpm",
    args: ["build"],
    stdio: "inherit",
    env: {
      ...process.env,
      CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
      CLERK_SECRET_KEY: "sk_test_ZmFrZS5jbGVyay5hY2NvdW50JA",
      VITE_CONVEX_URL: "https://ci.invalid",
      VITE_GATEWAY_URL: "https://ci.invalid",
    },
  });
  process.stdout.write(
    "Generated route tree stayed fresh during production build\n",
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
