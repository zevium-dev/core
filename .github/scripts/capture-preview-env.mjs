import { appendFileSync } from "node:fs";

const convexUrl = process.env.CONVEX_URL;
const githubEnv = process.env.GITHUB_ENV;
if (!convexUrl || !githubEnv) {
  throw new Error("CONVEX_URL and GITHUB_ENV are required");
}

appendFileSync(
  githubEnv,
  `VITE_CONVEX_URL=${convexUrl}\nCONVEX_SITE_URL=${convexUrl.replace(".convex.cloud", ".convex.site")}\n`,
);
