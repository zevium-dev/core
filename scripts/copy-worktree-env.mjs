import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { isLocalDeployment } from "./control-plane/guard-dev.mjs";

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
const worktreeRoot = realpathSync(process.cwd());

function copyEnvFile(source, destination) {
  if (process.platform !== "darwin") {
    copyFileSync(
      source,
      destination,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    return;
  }

  // Node 24's libuv has no APFS clone path. BSD cp uses native clonefile.
  // Publish from a sibling temp directory so an existing file is never replaced.
  const temporaryDirectory = mkdtempSync(
    join(dirname(destination), ".t3-env-"),
  );
  const temporaryFile = join(temporaryDirectory, "env");
  try {
    const clone = spawnSync("/bin/cp", ["-c", source, temporaryFile], {
      stdio: "ignore",
    });
    if (clone.status !== 0) {
      rmSync(temporaryFile, { force: true });
      copyFileSync(source, temporaryFile, constants.COPYFILE_EXCL);
    }
    linkSync(temporaryFile, destination);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (!projectRoot || realpathSync(projectRoot) === worktreeRoot) {
  console.log("Env copy skipped: no separate T3 project checkout.");
} else {
  const directories = [
    "",
    "apps/web",
    "apps/gateway",
    "convex",
    "packages/shared",
  ];
  const patterns = directories.flatMap((directory) =>
    [".env", ".env.*", ".dev.vars", ".dev.vars.*"].map((name) =>
      directory ? `${directory}/${name}` : name,
    ),
  );
  // Copy only ignored local config; tracked examples already exist in worktrees.
  const files = execFileSync(
    "git",
    [
      "-C",
      projectRoot,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...patterns,
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);

  let copied = 0;
  for (const file of files) {
    const source = join(projectRoot, file);
    const config = parseEnv(readFileSync(source, "utf8"));
    const hasRemoteTarget =
      (config.CONVEX_DEPLOYMENT &&
        !isLocalDeployment(config.CONVEX_DEPLOYMENT)) ||
      config.CONVEX_DEPLOY_KEY ||
      config.CONVEX_DEPLOYMENT_TOKEN ||
      config.CONVEX_SELF_HOSTED_URL ||
      config.CONVEX_SELF_HOSTED_ADMIN_KEY;
    if (hasRemoteTarget) {
      console.warn(
        `Env file ${file} contains a shared/remote Convex selector. See .agents/notes/architecture/convex-activation.md.`,
      );
      if (process.env.T3_COPY_REMOTE_CONVEX_ENV !== "1") {
        console.warn(
          "Skipped: explicitly set T3_COPY_REMOTE_CONVEX_ENV=1 to copy after reviewing the target; pnpm dev still requires the cutover guard.",
        );
        continue;
      }
    }
    const destination = join(worktreeRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    try {
      copyEnvFile(join(projectRoot, file), destination);
      copied += 1;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  console.log(`Copied ${copied} local env files; existing files preserved.`);
}
