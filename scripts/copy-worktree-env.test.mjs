import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve(import.meta.dirname, "copy-worktree-env.mjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "zevium env copy "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source checkout");
  const target = join(root, "target checkout");
  mkdirSync(source);
  mkdirSync(target);
  execFileSync("git", ["init", "--quiet", source]);
  writeFileSync(join(source, ".gitignore"), ".env*\n.dev.vars*\n");
  return {
    source,
    target,
    write(file, value) {
      const path = join(source, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value);
      return path;
    },
    run(projectRoot = source) {
      const env = { ...process.env };
      delete env.T3CODE_PROJECT_ROOT;
      if (projectRoot) env.T3CODE_PROJECT_ROOT = projectRoot;
      return execFileSync(process.execPath, [script], {
        cwd: target,
        env,
        encoding: "utf8",
      });
    },
  };
}

test("copies ignored env files and gateway vars, preserving edit isolation and permissions", (t) => {
  const f = fixture(t);
  const files = [
    ".env",
    ".env.local",
    "apps/web/.env.local",
    "apps/web/.env.production.local",
    "apps/gateway/.dev.vars",
    "convex/.env.local",
    "packages/shared/.env.local",
  ];
  for (const file of files) f.write(file, `fixture:${file}`);
  chmodSync(join(f.source, ".env"), 0o600);
  f.write(".env.example", "tracked example");
  execFileSync("git", ["-C", f.source, "add", "--force", ".env.example"]);
  assert.match(f.run(), /Copied 7 local env files/);
  for (const file of files) {
    assert.equal(readFileSync(join(f.target, file), "utf8"), `fixture:${file}`);
  }
  assert.equal(statSync(join(f.target, ".env")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.target, ".env.example")), false);
  writeFileSync(join(f.target, ".env"), "worktree edit");
  assert.equal(readFileSync(join(f.source, ".env"), "utf8"), "fixture:.env");
  assert.match(f.run(), /Copied 0 local env files/);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"), "worktree edit");
  assert.equal(
    readdirSync(f.target).some((name) => name.startsWith(".t3-env-")),
    false,
  );
});

test("preserves destination files on first setup", (t) => {
  const f = fixture(t);
  f.write(".env", "source config");
  writeFileSync(join(f.target, ".env"), "existing config");
  assert.match(f.run(), /Copied 0 local env files/);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"), "existing config");
});

test("skips local checkouts and setup without T3 context", (t) => {
  const f = fixture(t);
  assert.match(f.run(null), /Env copy skipped/);
  assert.match(f.run(f.target), /Env copy skipped/);
  const alias = join(f.source, "target alias");
  symlinkSync(f.target, alias, "dir");
  assert.match(f.run(alias), /Env copy skipped/);
});

// Setup must work before interactive mise hooks refresh PATH.
test("setup uses mise tools and stops when trust fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "zevium setup "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "commands");
  const mise = join(root, "mise");
  writeFileSync(
    mise,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SETUP_LOG"\nif [ "$1" = trust ]; then exit "${TRUST_EXIT:-0}"; fi\n',
  );
  chmodSync(mise, 0o755);
  const config = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../t3.json"), "utf8"),
  );
  const command = config.scripts.find(
    (entry) => entry.runOnWorktreeCreate,
  ).command;
  const env = { ...process.env, PATH: root, SETUP_LOG: log };
  execFileSync("/bin/sh", ["-c", command], { env });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "trust --quiet mise.toml",
    "exec -- node scripts/copy-worktree-env.mjs",
    "exec -- pnpm --config.confirm-modules-purge=false install --frozen-lockfile",
  ]);
  writeFileSync(log, "");
  assert.throws(() =>
    execFileSync("/bin/sh", ["-c", command], {
      env: { ...env, TRUST_EXIT: "1" },
    }),
  );
  assert.equal(readFileSync(log, "utf8"), "trust --quiet mise.toml\n");
});
