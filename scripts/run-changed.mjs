import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

const usage = () => {
  // eslint-disable-next-line no-console
  console.error(
    "Usage: node scripts/run-changed.mjs <tool> [--base <ref>] [--ext <csv>] -- <tool args...>\n" +
      "Example: node scripts/run-changed.mjs eslint --ext ts,tsx -- --cache\n" +
      "Example: node scripts/run-changed.mjs prettier --ext ts,tsx,md -- --check",
  );
};

const tool = argv.shift();
if (!tool) {
  usage();
  process.exit(2);
}

let baseRef;
let exts = [];

while (argv.length > 0) {
  const token = argv[0];
  if (token === "--") break;

  if (token === "--base") {
    argv.shift();
    baseRef = argv.shift();
    continue;
  }

  if (token === "--ext") {
    argv.shift();
    const raw = argv.shift() ?? "";
    exts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith(".") ? s.toLowerCase() : `.${s.toLowerCase()}`));
    continue;
  }

  break;
}

if (argv[0] !== "--") {
  usage();
  process.exit(2);
}
argv.shift();
const toolArgs = argv;

const execGit = (args) => {
  const res = spawnSync("git", args, { encoding: "buffer" });
  if (res.status !== 0) return null;
  return res.stdout;
};

const uniq = (items) => Array.from(new Set(items));

const parseZList = (buf) =>
  buf
    .toString("utf8")
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);

const resolveDefaultBaseRef = () => {
  if (process.env.CHANGED_FILES_BASE) return process.env.CHANGED_FILES_BASE;

  // GitHub Actions PRs
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;

  // Generic CI: compare to previous commit by default (safe on default-branch builds)
  if (process.env.CI) return "HEAD~1";

  const originHead = execGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const originHeadRef = originHead?.toString("utf8").trim();
  if (originHeadRef) return originHeadRef;

  return "origin/develop";
};

const base = baseRef ?? resolveDefaultBaseRef();

const changedFromBase = (() => {
  const out = execGit(["diff", "-z", "--name-only", "--diff-filter=ACMRTUXB", `${base}...HEAD`]);
  if (out) return parseZList(out);
  return [];
})();

const changedWorktree = (() => {
  const out = execGit(["diff", "-z", "--name-only", "--diff-filter=ACMRTUXB"]);
  if (!out) return [];
  return parseZList(out);
})();

const changedIndex = (() => {
  const out = execGit(["diff", "-z", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]);
  if (!out) return [];
  return parseZList(out);
})();

const untracked = (() => {
  const out = execGit(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (!out) return [];
  return parseZList(out);
})();

const changedFiles = uniq([...changedFromBase, ...changedWorktree, ...changedIndex, ...untracked])
  .map((p) => p.replaceAll("\\", "/"))
  .filter((p) => {
    if (!exts.length) return true;
    return exts.includes(path.extname(p).toLowerCase());
  })
  .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());

if (changedFiles.length === 0) {
  process.exit(0);
}

const binName = process.platform === "win32" ? `${tool}.cmd` : tool;
const binPath = path.resolve("node_modules", ".bin", binName);

const run = spawnSync(binPath, [...toolArgs, ...changedFiles], { stdio: "inherit" });
process.exit(run.status ?? 1);
