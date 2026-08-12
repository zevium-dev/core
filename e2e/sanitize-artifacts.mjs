#!/usr/bin/env node

import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(
  process.env.E2E_ARTIFACTS ?? new URL("./artifacts", import.meta.url).pathname,
);
const textExtensions = new Set([".json", ".log", ".txt"]);
const unsafeMediaExtensions = new Set([".jpeg", ".jpg", ".png", ".webp"]);
const exactSecrets = [
  process.env.E2E_API_KEY,
  process.env.E2E_EMAIL,
  process.env.E2E_PASSWORD,
  process.env.E2E_OTP,
  process.env.STRIPE_SECRET_KEY,
].filter((value) => typeof value === "string" && value.length >= 4);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeText(source) {
  let value = source;
  for (const secret of exactSecrets) {
    value = value.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  return value
    .replace(/sk_(?:test|live)_[A-Za-z0-9_]+/g, "[REDACTED_STRIPE_KEY]")
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

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("Artifact path escaped evidence directory");
    }
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (unsafeMediaExtensions.has(extension)) {
      await unlink(path);
      continue;
    }
    if (!textExtensions.has(extension)) {
      await unlink(path);
      continue;
    }
    const metadata = await stat(path);
    if (metadata.size > 2_000_000) {
      await unlink(path);
      continue;
    }
    const original = await readFile(path, "utf8");
    await writeFile(path, sanitizeText(original), { mode: 0o600 });
  }
}

await walk(root);
process.stdout.write("artifact evidence sanitized\n");
