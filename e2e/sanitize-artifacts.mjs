#!/usr/bin/env node

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

const sourceRoot = resolve(
  process.env.E2E_ARTIFACTS ?? new URL("./artifacts", import.meta.url).pathname,
);
const outputRoot = resolve(
  process.env.E2E_SANITIZED_ARTIFACTS ??
    new URL("./artifacts-sanitized", import.meta.url).pathname,
);
const stagingRoot = `${outputRoot}.tmp-${process.pid}`;
const textExtensions = new Set([".json", ".log", ".txt"]);
const omittedMediaExtensions = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const maxArtifactEntries = 500;
const maxArtifactDepth = 32;
const maxSanitizedBytes = 20_000_000;
let artifactEntries = 0;
let sanitizedBytes = 0;
const exactSecrets = [
  process.env.CONVEX_DEPLOY_KEY,
  process.env.E2E_API_KEY,
  process.env.E2E_EMAIL,
  process.env.E2E_OTP,
  process.env.E2E_PASSWORD,
  process.env.STRIPE_CHECKOUT_PROOF_KEY,
  process.env.STRIPE_CONNECT_PROOF_KEY,
  process.env.STRIPE_WEBHOOK_ADMIN_KEY,
].filter((value) => typeof value === "string" && value.length >= 4);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeText(source, secrets = exactSecrets) {
  let value = source;
  for (const secret of secrets) {
    value = value.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  return value
    .replace(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+/g, "[REDACTED_STRIPE_KEY]")
    .replace(/whsec_[A-Za-z0-9_]+/g, "[REDACTED_WEBHOOK_SECRET]")
    .replace(/zv_(?:test|live)_[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[REDACTED_JWT]",
    )
    .replace(
      /https:\/\/checkout\.stripe\.com\/[^\s"']+/g,
      "[REDACTED_CHECKOUT_URL]",
    );
}

async function copySanitizedTree(directory, depth = 0) {
  invariant(depth <= maxArtifactDepth, "Artifact tree exceeds depth limit");
  const metadata = await lstat(directory);
  invariant(metadata.isDirectory(), "Artifact source must be a real directory");
  invariant(!metadata.isSymbolicLink(), "Artifact source cannot be a symlink");

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    artifactEntries += 1;
    invariant(
      artifactEntries <= maxArtifactEntries,
      "Artifact tree exceeds 500-entry limit",
    );
    const sourcePath = resolve(directory, entry.name);
    invariant(
      isWithin(sourceRoot, sourcePath),
      "Artifact path escaped evidence directory",
    );
    const entryMetadata = await lstat(sourcePath);
    invariant(
      !entryMetadata.isSymbolicLink(),
      `Artifact tree contains symlink: ${relative(sourceRoot, sourcePath)}`,
    );
    invariant(
      entryMetadata.isDirectory() || entryMetadata.isFile(),
      `Artifact tree contains special file: ${relative(sourceRoot, sourcePath)}`,
    );

    const destinationPath = resolve(
      stagingRoot,
      relative(sourceRoot, sourcePath),
    );
    invariant(
      isWithin(stagingRoot, destinationPath),
      "Sanitized artifact path escaped staging directory",
    );
    if (entryMetadata.isDirectory()) {
      await mkdir(destinationPath, { recursive: true, mode: 0o700 });
      await copySanitizedTree(sourcePath, depth + 1);
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    if (
      omittedMediaExtensions.has(extension) ||
      !textExtensions.has(extension)
    ) {
      continue;
    }
    invariant(
      entryMetadata.size <= 2_000_000,
      `Artifact exceeds 2 MB limit: ${relative(sourceRoot, sourcePath)}`,
    );
    sanitizedBytes += entryMetadata.size;
    invariant(
      sanitizedBytes <= maxSanitizedBytes,
      "Sanitized artifact text exceeds 20 MB limit",
    );
    const original = await readFile(sourcePath, "utf8");
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeFile(destinationPath, sanitizeText(original), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(destinationPath, 0o600);
  }
}

async function main() {
  invariant(sourceRoot !== outputRoot, "Raw and sanitized roots must differ");
  invariant(
    dirname(sourceRoot) === dirname(outputRoot),
    "Raw and sanitized roots must be sibling directories",
  );
  invariant(
    !isWithin(sourceRoot, outputRoot) && !isWithin(outputRoot, sourceRoot),
    "Raw and sanitized roots cannot contain each other",
  );
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    await copySanitizedTree(sourceRoot);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`artifact evidence sanitized into ${outputRoot}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  await main();
}
