import { resolve } from "node:path";
import { runTrackedCommand } from "./tracked-tree.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const commands = [
  ["pnpm", ["exec", "turbo", "test"]],
  ["pnpm", ["run", "test:convex"]],
  ["pnpm", ["run", "test:proofs"]],
  ["pnpm", ["--dir", "apps/web", "run", "test:csrf-runtime"]],
  ["pnpm", ["run", "test:build-contract"]],
  ["pnpm", ["run", "test:e2e-harness"]],
  ["pnpm", ["run", "test:quality"]],
  ["pnpm", ["run", "test:deploy"]],
  ["pnpm", ["run", "test:audit"]],
];

try {
  for (const [command, args] of commands) {
    const result = runTrackedCommand({
      cwd: repositoryRoot,
      command,
      args,
      env: { ...process.env, CI: "true" },
      label: `test command: ${command} ${args.join(" ")}`,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
