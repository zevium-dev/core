import { appendFileSync } from "node:fs";

const convexUrl = process.env.CONVEX_URL;
const githubEnv = process.env.GITHUB_ENV;
if (!convexUrl || !githubEnv) {
  throw new Error("CONVEX_URL and GITHUB_ENV are required");
}
const convexSiteUrl = convexUrl.replace(".convex.cloud", ".convex.site");

appendFileSync(
  githubEnv,
  `VITE_CONVEX_URL=${convexUrl}\nCONVEX_SITE_URL=${convexSiteUrl}\n`,
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `convex_url=${convexUrl}\nconvex_site_url=${convexSiteUrl}\n`,
  );
}
