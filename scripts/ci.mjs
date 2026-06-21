#!/usr/bin/env node
/**
 * Runs every CI step in parallel, prefixes each step's output with a colored
 * label, waits for all of them to finish, then exits non-zero if any failed.
 *
 * Why a script (not `pnpm a & pnpm b & wait`): `wait` only surfaces the exit
 * code of the last job, so a failure in an earlier job would be silently
 * swallowed. This script tracks every child's exit code, forwards SIGINT so
 * Ctrl-C kills all of them, and prints a summary table at the end.
 */
import { spawn } from "node:child_process";

const STEPS = ["typecheck", "lint", "lint:eslint", "test", "build", "format:check"];

const COLORS = [
  ["\x1b[36m", "cyan"],
  ["\x1b[35m", "magenta"],
  ["\x1b[33m", "yellow"],
  ["\x1b[32m", "green"],
  ["\x1b[34m", "blue"],
  ["\x1b[31m", "red"],
];
const RESET = "\x1b[0m";

const labelWidth = Math.max(...STEPS.map((s) => s.length));

const makeLinePrefixer = (label, color) => {
  const tag = `${color}[${label.padEnd(labelWidth)}]${RESET} `;
  let buffer = "";
  return (chunk, write) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      write(`${tag}${line}\n`);
    }
  };
};

const procs = STEPS.map((step, i) => {
  const [color] = COLORS[i % COLORS.length] ?? ["", ""];
  const proc = spawn("pnpm", ["run", step], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const flushOut = makeLinePrefixer(step, color);
  const flushErr = makeLinePrefixer(step, color);

  proc.stdout.on("data", (d) => flushOut(d, process.stdout.write.bind(process.stdout)));
  proc.stderr.on("data", (d) => flushErr(d, process.stderr.write.bind(process.stderr)));
  proc.on("close", () => flushOut("\n", process.stdout.write.bind(process.stdout)));

  return { color, proc, step };
});

// Forward Ctrl-C so one interrupt kills every spawned step instead of orphans.
process.on("SIGINT", () => {
  for (const { proc } of procs) proc.kill("SIGINT");
  process.exit(130);
});

const results = await Promise.all(
  procs.map(
    ({ color, proc, step }) =>
      new Promise((resolve) => {
        proc.on("close", (code) => resolve({ code, color, step }));
      }),
  ),
);

console.log("\nCI summary:");
let failed = false;
for (const { code, color, step } of results) {
  const ok = code === 0;
  if (!ok) failed = true;
  const mark = ok ? `${color}PASS${RESET}` : `${color}FAIL${RESET}`;
  console.log(`  ${mark}  ${step}`);
}
process.exit(failed ? 1 : 0);
