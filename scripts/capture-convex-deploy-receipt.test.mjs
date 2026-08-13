import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseConvexDeployReceipt,
  writeReceiptAtomic,
} from "./capture-convex-deploy-receipt.mjs";

const receipt = {
  schema: "zevium.convex-deploy-receipt/v1",
  receiptId: "jh7123456789abcdefghijklmnop",
  gitSha: "a".repeat(40),
  sourceRunId: "123456789",
  cloudUrl: "https://native-stag-123.convex.cloud",
  siteUrl: "https://native-stag-123.convex.site",
  activatedAt: "2026-08-12T12:00:00.000Z",
};

test("strictly parses a native Convex receipt", () => {
  assert.deepEqual(parseConvexDeployReceipt(receipt), receipt);
});

test("rejects unknown fields, mismatched deployments, and noncanonical values", () => {
  assert.throws(
    () => parseConvexDeployReceipt({ ...receipt, configuredId: "human" }),
    /invalid/,
  );
  assert.throws(
    () =>
      parseConvexDeployReceipt({
        ...receipt,
        siteUrl: "https://other.convex.site",
      }),
    /different deployments/,
  );
  assert.throws(
    () => parseConvexDeployReceipt({ ...receipt, gitSha: "A".repeat(40) }),
    /invalid/,
  );
});

test("writes atomically with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zevium-convex-receipt-"));
  const path = join(directory, "receipt.json");
  writeReceiptAtomic(path, receipt);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receipt);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test("rejects symlink and permissive existing targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zevium-convex-receipt-"));
  const target = join(directory, "target.json");
  writeReceiptAtomic(target, receipt);
  const link = join(directory, "receipt-link.json");
  await symlink(target, link);
  assert.throws(() => writeReceiptAtomic(link, receipt), /regular file/);
  await chmod(target, 0o644);
  assert.throws(() => writeReceiptAtomic(target, receipt), /too broad/);
});
