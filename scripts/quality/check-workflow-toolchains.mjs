import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const dependencyCommand =
  /(^|[\s|;&])(corepack|node|npm|npx|oxlint|pnpm|prettier|tsx|turbo|vite|vitest)(\s|$)|(^|\n)\s*(?:(?:bash|sh)\s+)?(?:\.\/)?(?:e2e|scripts)\/\S+\.sh(?:\s|$)/m;
export const toolchainPolicy = Object.freeze({
  miseAction: "jdx/mise-action@7e36c90d9ab29c415a2384db3006f3ec8a8cc654",
  miseVersion: "2026.7.13",
  nodeVersion: "24.15.0",
  pnpmVersion: "11.8.0",
  installArgs:
    "node@24.15.0 npm:pnpm@11.8.0 actionlint@1.7.12 gitleaks@8.30.1 shellcheck@0.11.0",
});
const exactMiseConfig = [
  "[tasks]",
  'ci = "pnpm run ci:pr"',
  "",
  "[tools]",
  'actionlint = "1.7.12"',
  'gitleaks = "8.30.1"',
  'node = "24.15.0"',
  '"npm:pnpm" = "11.8.0"',
  'shellcheck = "0.11.0"',
].join("\n");
const runtimeVersions = [
  ["actionlint", ["-version"], /^1\.7\.12(?:\n|$)/],
  ["gitleaks", ["version"], /^8\.30\.1$/],
  ["node", ["--version"], /^v24\.15\.0$/],
  ["pnpm", ["--version"], /^11\.8\.0$/],
  ["shellcheck", ["--version"], /\bversion: 0\.11\.0\b/],
];

function runText(step) {
  return typeof step?.run === "string" ? step.run.trim() : "";
}

export function validateWorkflowToolchain(path) {
  const source = readFileSync(path, "utf8");
  if (source.includes("restore-keys")) {
    throw new Error(
      `${path}: broad pnpm cache restore-keys are forbidden; exact key-only cache matches required`,
    );
  }
  const document = parse(source);
  const failures = [];
  for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const miseIndexes = steps
      .map((step, index) => [step, index])
      .filter(([step]) =>
        typeof step?.uses === "string"
          ? step.uses.startsWith("jdx/mise-action@")
          : false,
      );
    const usesRepositoryDependencies =
      miseIndexes.length > 0 ||
      steps.some((step) => dependencyCommand.test(runText(step)));
    if (!usesRepositoryDependencies) continue;
    if (miseIndexes.length !== 1) {
      failures.push(`${jobName}: expected exactly one mise bootstrap`);
      continue;
    }

    const [miseStep, miseIndex] = miseIndexes[0];
    if (miseStep.uses !== toolchainPolicy.miseAction) {
      failures.push(`${jobName}: mise action must use exact pinned SHA`);
    }
    if (String(miseStep.with?.version ?? "") !== toolchainPolicy.miseVersion) {
      failures.push(`${jobName}: mise binary version is not pinned`);
    }
    if (miseStep.with?.install !== true && miseStep.with?.install !== "true") {
      failures.push(`${jobName}: mise install must be enabled explicitly`);
    }
    if (miseStep.with?.install_args !== toolchainPolicy.installArgs) {
      failures.push(`${jobName}: mise install_args must pin exact tools`);
    }

    const exactVerification = [
      `test "$(node --version)" = "v${toolchainPolicy.nodeVersion}"`,
      `test "$(pnpm --version)" = "${toolchainPolicy.pnpmVersion}"`,
    ].join("\n");
    const verifyIndexes = steps
      .map((step, index) => [runText(step), index])
      .filter(([run]) => run === exactVerification)
      .map(([, index]) => index);
    const verifyIndex = verifyIndexes[0] ?? -1;
    const installIndexes = steps
      .map((step, index) => [runText(step), index])
      .filter(([run]) => run === "pnpm install --frozen-lockfile")
      .map(([, index]) => index);
    const allInstallIndexes = steps
      .map((step, index) => [runText(step), index])
      .filter(([run]) => /(^|\s)pnpm\s+(?:install|i)(?:\s|$)/m.test(run))
      .map(([, index]) => index);
    if (verifyIndexes.length !== 1 || verifyIndex <= miseIndex) {
      failures.push(
        `${jobName}: exact Node/pnpm verification must follow mise`,
      );
    }
    if (
      installIndexes.length !== 1 ||
      installIndexes[0] <= miseIndex ||
      (verifyIndex !== -1 && installIndexes[0] <= verifyIndex)
    ) {
      failures.push(
        `${jobName}: frozen pnpm install must occur once after verified bootstrap`,
      );
    }
    if (
      allInstallIndexes.length !== 1 ||
      allInstallIndexes[0] !== installIndexes[0]
    ) {
      failures.push(
        `${jobName}: additional pnpm install commands are forbidden`,
      );
    }

    const installIndex = installIndexes[0] ?? Number.POSITIVE_INFINITY;
    for (let index = 0; index < steps.length; index += 1) {
      const run = runText(steps[index]);
      if (
        index < installIndex &&
        index !== verifyIndex &&
        dependencyCommand.test(run)
      ) {
        failures.push(
          `${jobName}: repository dependency command used before frozen install`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Workflow toolchain failures in ${path}:\n${failures.join("\n")}`,
    );
  }
}

export function checkWorkflowToolchains(root = repositoryRoot) {
  const workflowDirectory = resolve(root, ".github/workflows");
  const workflows = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(workflowDirectory, name))
    .sort();
  for (const workflow of workflows) validateWorkflowToolchain(workflow);

  const misePath = resolve(root, "mise.toml");
  const mise = readFileSync(misePath, "utf8").trim();
  const packageJson = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  if (mise !== exactMiseConfig) {
    throw new Error(
      "mise.toml must match exact task and five-tool version policy",
    );
  }
  if (packageJson.packageManager !== `pnpm@${toolchainPolicy.pnpmVersion}`) {
    throw new Error("packageManager pnpm pin disagrees with workflow policy");
  }
  return workflows.length;
}

export function attestMiseRuntime(root = repositoryRoot) {
  const environment = { ...process.env, MISE_EXPERIMENTAL: "true" };
  const configs = spawnSync("mise", ["config", "ls", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  if (configs.status !== 0) {
    throw new Error(
      `mise rejected repository config:\n${configs.stdout}${configs.stderr}`,
    );
  }
  const expectedPath = realpathSync(resolve(root, "mise.toml"));
  const resolved = JSON.parse(configs.stdout).filter(
    (entry) => realpathSync(entry.path) === expectedPath,
  );
  if (
    resolved.length !== 1 ||
    JSON.stringify(resolved[0].tools) !==
      JSON.stringify([
        "actionlint",
        "gitleaks",
        "node",
        "npm:pnpm",
        "shellcheck",
      ])
  ) {
    throw new Error("mise did not resolve exact repository tool set");
  }

  for (const [tool, args, expected] of runtimeVersions) {
    const result = spawnSync("mise", ["exec", "--", tool, ...args], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.status !== 0 || !expected.test(output)) {
      throw new Error(
        `mise runtime ${tool} failed exact version attestation: ${output}`,
      );
    }
  }
  return runtimeVersions.length;
}

if (process.argv[1] === import.meta.filename) {
  try {
    const count = checkWorkflowToolchains();
    const runtimes = attestMiseRuntime();
    process.stdout.write(
      `Workflow toolchains locked: ${count} workflows; ${runtimes} mise runtimes; mise ${toolchainPolicy.miseVersion}; Node ${toolchainPolicy.nodeVersion}; pnpm ${toolchainPolicy.pnpmVersion}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
