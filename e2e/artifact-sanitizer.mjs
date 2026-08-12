#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const residualDetectors = [
  {
    label: "email address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    label: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    label: "provider or application secret",
    pattern:
      /\b(?:sk_(?:live|test)|rk_(?:live|test)|whsec|zv|ak|cs_(?:live|test)|pi|re|user|org|sess)_[A-Za-z0-9_-]{6,}\b/,
  },
  {
    label: "bearer credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/i,
  },
  { label: "payment card number", pattern: /\b(?:\d[ -]*?){13,19}\b/ },
  {
    label: "sensitive assignment",
    pattern:
      /\b(?:password|secret|token|api[_ -]?key|authorization|cookie)\s*[:=]\s*(?!\[redacted(?:-|\]))[^\s<]{4,}/i,
  },
];

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function assertRegularUnslinkedFile(path, label) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (realpathSync(parent) !== resolve(parent)) {
    throw new Error(`${label} path may not traverse symlinks`);
  }
}

function assertOutputPath(path) {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("output directory must be a real directory, not a symlink");
  }
  if (realpathSync(parent) !== resolve(parent)) {
    throw new Error("output directory path may not traverse symlinks");
  }
  try {
    lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("sanitized output must be a new file");
}

export function sanitizeText(input) {
  return input
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-jwt]",
    )
    .replace(
      /\b(?:sk_(?:live|test)|rk_(?:live|test)|whsec|zv|ak|cs_(?:live|test)|pi|re|user|org|sess)_[A-Za-z0-9_-]{6,}\b/g,
      "[redacted-id]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[redacted-payment-number]")
    .replace(
      /(\b(?:password|secret|token|api[_ -]?key|authorization|cookie)\s*[:=]\s*)[^\s<]{4,}/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:checkout|session|token|key|email)=)[^&#\s]+/gi,
      "$1[redacted]",
    );
}

export function assertNoSensitiveText(value) {
  for (const detector of residualDetectors) {
    if (detector.pattern.test(value)) {
      throw new Error(`sanitized artifact still contains ${detector.label}`);
    }
  }
}

function stripeProjection(raw, mode) {
  const parsed = JSON.parse(raw);
  if (mode === "stripe-session") {
    return JSON.stringify(
      {
        kind: "stripe-checkout-session",
        checkoutSessionSha256: parsed.id ? hash(parsed.id) : null,
        paymentIntentSha256: parsed.payment_intent
          ? hash(parsed.payment_intent)
          : null,
        paymentStatus:
          typeof parsed.payment_status === "string"
            ? parsed.payment_status
            : null,
        status: typeof parsed.status === "string" ? parsed.status : null,
      },
      null,
      2,
    );
  }
  if (mode === "stripe-refund") {
    return JSON.stringify(
      {
        kind: "stripe-refund",
        refundSha256: parsed.id ? hash(parsed.id) : null,
        paymentIntentSha256: parsed.payment_intent
          ? hash(parsed.payment_intent)
          : null,
        status: typeof parsed.status === "string" ? parsed.status : null,
      },
      null,
      2,
    );
  }
  throw new Error(`unsupported Stripe projection: ${mode}`);
}

export function sanitizeArtifact({ inputPath, outputPath, mode = "text" }) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  assertRegularUnslinkedFile(input, "input");
  if (input === output)
    throw new Error("input and output must be separate paths");
  assertOutputPath(output);

  const raw = readFileSync(input, "utf8");
  if (Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} byte limit`);
  }
  const projected = mode === "text" ? raw : stripeProjection(raw, mode);
  const sanitized = `${sanitizeText(projected).trimEnd()}\n`;
  assertNoSensitiveText(sanitized);
  writeFileSync(output, sanitized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return output;
}

function main() {
  const [inputPath, outputPath, mode = "text"] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error(
      "usage: artifact-sanitizer.mjs <raw-input> <new-output> [text|stripe-session|stripe-refund]",
    );
  }
  sanitizeArtifact({ inputPath, outputPath, mode });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[artifact-sanitizer] ${error.message}\n`);
    process.exitCode = 1;
  }
}
