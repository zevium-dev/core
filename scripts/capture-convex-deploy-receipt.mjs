#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONVEX_DEPLOY_RECEIPT_SCHEMA = "zevium.convex-deploy-receipt/v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function convexUrl(value, suffix, name) {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(suffix)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return url.origin;
}

export function parseConvexDeployReceipt(value) {
  if (
    !exactKeys(value, [
      "activatedAt",
      "cloudUrl",
      "gitSha",
      "receiptId",
      "schema",
      "siteUrl",
      "sourceRunId",
    ]) ||
    value.schema !== CONVEX_DEPLOY_RECEIPT_SCHEMA ||
    typeof value.receiptId !== "string" ||
    !RECEIPT_ID_PATTERN.test(value.receiptId) ||
    typeof value.gitSha !== "string" ||
    !SHA_PATTERN.test(value.gitSha) ||
    typeof value.sourceRunId !== "string" ||
    !RUN_ID_PATTERN.test(value.sourceRunId) ||
    typeof value.activatedAt !== "string" ||
    Number.isNaN(Date.parse(value.activatedAt)) ||
    new Date(value.activatedAt).toISOString() !== value.activatedAt
  ) {
    throw new Error("Convex deployment receipt is invalid");
  }
  const cloudUrl = convexUrl(value.cloudUrl, ".convex.cloud", "cloudUrl");
  const siteUrl = convexUrl(value.siteUrl, ".convex.site", "siteUrl");
  if (
    new URL(cloudUrl).hostname.replace(/\.convex\.cloud$/, "") !==
    new URL(siteUrl).hostname.replace(/\.convex\.site$/, "")
  ) {
    throw new Error("Convex receipt URLs identify different deployments");
  }
  return { ...value, cloudUrl, siteUrl };
}

function assertSecureTarget(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Receipt output must be a regular file");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("Existing receipt output permissions are too broad");
}

export function writeReceiptAtomic(path, receipt) {
  const parsed = parseConvexDeployReceipt(receipt);
  const target = resolve(path);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSecureTarget(target);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    const directory = openSync(parent, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || argv[1].trim() === "") {
    throw new Error("usage: capture-convex-deploy-receipt.mjs --output PATH");
  }
  return resolve(argv[1]);
}

export function captureConvexDeployReceipt({
  output,
  gitSha = process.env.GITHUB_SHA,
  sourceRunId = process.env.GITHUB_RUN_ID,
  spawn = spawnSync,
}) {
  if (typeof gitSha !== "string" || !SHA_PATTERN.test(gitSha))
    throw new Error("GITHUB_SHA must be an exact lowercase 40-character SHA");
  if (typeof sourceRunId !== "string" || !RUN_ID_PATTERN.test(sourceRunId))
    throw new Error("GITHUB_RUN_ID must be a positive decimal identifier");
  if (!process.env.CONVEX_DEPLOY_KEY)
    throw new Error("CONVEX_DEPLOY_KEY is required");

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(root, "node_modules/.bin/convex");
  const args = JSON.stringify({ gitSha, sourceRunId });
  const result = spawn(
    cli,
    [
      "run",
      "deploymentProof:record",
      args,
      "--codegen",
      "disable",
      "--typecheck",
      "disable",
    ],
    { cwd: root, encoding: "utf8", env: process.env, shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Convex receipt capture failed (exit ${result.status})`);
  }
  let receipt;
  try {
    receipt = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Convex receipt command returned invalid JSON");
  }
  const parsed = parseConvexDeployReceipt(receipt);
  if (parsed.gitSha !== gitSha || parsed.sourceRunId !== sourceRunId)
    throw new Error("Convex receipt does not match this workflow run");
  writeReceiptAtomic(output, parsed);
  return parsed;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const output = parseArgs(process.argv.slice(2));
    const receipt = captureConvexDeployReceipt({ output });
    process.stdout.write(
      `Captured Convex receipt ${receipt.receiptId} for ${receipt.gitSha}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Convex receipt capture failed"}\n`,
    );
    process.exitCode = 1;
  }
}
