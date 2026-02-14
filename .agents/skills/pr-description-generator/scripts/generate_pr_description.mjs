#!/usr/bin/env node

/*
  PR Description Generator

  Generates a copy-pastable markdown block containing:
  - Title (from first commit subject or override)
  - Summary bullets (deduped commit subjects)
  - Changes (name-status + diffstat)
  - Testing (repo-aware suggestions)
  - Notes (only when needed)
*/

import fs from "node:fs";
import { spawnSync } from "node:child_process";

function runGit(args, { check = true } = {}) {
  const cp = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (check && cp.status !== 0) {
    const err = new Error(cp.stderr?.trim() || `git ${args.join(" ")} failed`);
    err.exitCode = cp.status ?? 1;
    throw err;
  }

  return cp;
}

function gitOk(args) {
  try {
    runGit(args, { check: true });
    return true;
  } catch {
    return false;
  }
}

function detectBaseBranch(preferred) {
  const candidates = [preferred];
  if (preferred !== "origin/develop") candidates.push("origin/develop");
  if (preferred !== "develop") candidates.push("develop");

  for (const c of candidates) {
    if (gitOk(["rev-parse", "--verify", c])) return c;
  }

  throw new Error(`Cannot find base branch. Tried: ${candidates.join(", ")}. Fetch remotes or pass --base explicitly.`);
}

function ensureFetched(base, { noFetch }) {
  if (noFetch) return;
  if (!base.startsWith("origin/")) return;

  // Best-effort fetch; non-fatal for offline use.
  try {
    runGit(["fetch", "origin", "develop"], { check: false });
  } catch {
    // ignore
  }
}

function currentBranch() {
  const cp = runGit(["branch", "--show-current"]);
  const b = (cp.stdout || "").trim();
  return b || "(detached)";
}

function repoRoot() {
  const cp = runGit(["rev-parse", "--show-toplevel"]);
  return (cp.stdout || "").trim();
}

function commitSubjects(base, head) {
  const cp = runGit(["log", "--no-merges", "--format=%s", `${base}..${head}`]);
  return (cp.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function changedFiles(base, head) {
  const cp = runGit(["diff", "--name-status", `${base}...${head}`]);
  return (cp.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+$/, ""))
    .filter((s) => s.trim());
}

function diffstat(base, head) {
  const cp = runGit(["diff", "--stat", `${base}...${head}`]);
  return (cp.stdout || "").replace(/\s+$/, "");
}

function isMigrationTouched(nameStatusLines) {
  for (const ln of nameStatusLines) {
    const parts = ln.split("\t");
    const p = (parts.at(-1) || "").trim();
    if (p.startsWith("drizzle/") && p.endsWith(".sql")) return true;
  }
  return false;
}

function guessTitle(subjects, branch) {
  if (subjects.length > 0) return subjects[0];
  return `PR: ${branch}`;
}

function normalizeSummaryBullet(s) {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\(#\d+\)$/, "")
    .trim();
}

function summaryBullets(subjects) {
  if (subjects.length === 0) {
    return ["No commits found between base and HEAD (check base branch)."];
  }

  const bullets = [];
  const seen = new Set();
  for (const s of subjects) {
    const b = normalizeSummaryBullet(s);
    if (!b) continue;
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(b);
    if (bullets.length >= 6) break;
  }
  return bullets;
}

function suggestTestingCommands() {
  const cmds = [];
  if (fs.existsSync("mise.toml") || fs.existsSync(".mise.toml")) cmds.push("mise run ci");
  if (fs.existsSync("pnpm-lock.yaml")) cmds.push("pnpm -s run ci:pr");
  if (cmds.length === 0) cmds.push("<add your local test command>");
  return cmds;
}

function renderMarkdown(pr) {
  const lines = [];
  lines.push(`# ${pr.title}`);
  lines.push("");
  lines.push("## Summary");
  for (const b of pr.summary) lines.push(`- ${b}`);

  lines.push("");
  lines.push("## Changes");
  if (pr.changedFiles.length > 0) {
    lines.push("Changed files:");
    lines.push("");
    lines.push("```text");
    lines.push(...pr.changedFiles);
    lines.push("```");
  } else {
    lines.push("- No file changes detected (check base branch).");
  }

  if (pr.diffstat) {
    lines.push("");
    lines.push("Diffstat:");
    lines.push("");
    lines.push("```text");
    lines.push(pr.diffstat);
    lines.push("```");
  }

  lines.push("");
  lines.push("## Testing");
  for (const c of pr.testing) lines.push(`- \`${c}\``);

  if (pr.notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    for (const n of pr.notes) lines.push(`- ${n}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`Base: \`${pr.base}\``);
  lines.push(`Head: \`${pr.head}\``);
  lines.push(`Branch: \`${pr.branch}\``);
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function parseArgs(argv) {
  const out = {
    base: "origin/develop",
    head: "HEAD",
    title: null,
    noFetch: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i] || out.base;
    else if (a === "--head") out.head = argv[++i] || out.head;
    else if (a === "--title") out.title = argv[++i] || out.title;
    else if (a === "--no-fetch") out.noFetch = true;
    else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      out.unknown = a;
    }
  }

  return out;
}

function printHelp() {
  process.stdout.write(`Usage: generate_pr_description.js [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --base <ref>     Base ref to compare (default: origin/develop)\n`);
  process.stdout.write(`  --head <ref>     Head ref to compare (default: HEAD)\n`);
  process.stdout.write(`  --title <title>  Override PR title\n`);
  process.stdout.write(`  --no-fetch       Do not fetch origin/develop\n`);
  process.stdout.write(`  -h, --help       Show help\n`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.unknown) {
    process.stderr.write(`error: unknown argument ${args.unknown}\n`);
    printHelp();
    return 2;
  }

  try {
    repoRoot(); // ensure we're in a git repo

    ensureFetched(args.base, { noFetch: args.noFetch });
    const base = detectBaseBranch(args.base);

    const branch = currentBranch();
    const subjects = commitSubjects(base, args.head);
    const changed = changedFiles(base, args.head);
    const stat = diffstat(base, args.head);
    const summary = summaryBullets(subjects);

    const notes = [];
    if (isMigrationTouched(changed)) {
      notes.push("Includes DB migration changes; ensure migration applies cleanly.");
    }

    const title = args.title && args.title.trim() ? args.title.trim() : guessTitle(subjects, branch);

    const md = renderMarkdown({
      title,
      base,
      head: args.head,
      branch,
      subjects,
      summary,
      changedFiles: changed,
      diffstat: stat,
      testing: suggestTestingCommands(),
      notes,
    });

    process.stdout.write("```markdown\n");
    process.stdout.write(md);
    process.stdout.write("```\n");
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e && e.message ? e.message : String(e)}\n`);
    return 2;
  }
}

process.exitCode = main();
