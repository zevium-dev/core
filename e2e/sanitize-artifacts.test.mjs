import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = new URL("./sanitize-artifacts.mjs", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zevium-sanitize-"));
  const source = join(root, "raw");
  const output = join(root, "safe");
  await mkdir(source);
  return { root, source, output };
}

test("writes only redacted text into separate private tree", async () => {
  const { source, output } = await fixture();
  const secret = "rk_test_hostile_secret";
  await writeFile(
    join(source, "proof.json"),
    JSON.stringify({ secret, webhook: "whsec_unsafe", key: "zv_test_unsafe" }),
  );
  await writeFile(join(source, "screen.png"), secret);
  await writeFile(join(source, "unknown.bin"), secret);

  await execFileAsync(process.execPath, [script], {
    env: {
      ...process.env,
      E2E_ARTIFACTS: source,
      E2E_SANITIZED_ARTIFACTS: output,
      STRIPE_CHECKOUT_PROOF_KEY: secret,
    },
  });

  const safe = await readFile(join(output, "proof.json"), "utf8");
  assert.doesNotMatch(safe, /hostile_secret|whsec_unsafe|zv_test_unsafe/);
  assert.equal((await lstat(join(output, "proof.json"))).mode & 0o777, 0o600);
  await assert.rejects(readFile(join(output, "screen.png")));
  await assert.rejects(readFile(join(output, "unknown.bin")));
  assert.match(
    await readFile(join(source, "proof.json"), "utf8"),
    /hostile_secret/,
  );
});

test("rejects symlinks and publishes no sanitized tree", async () => {
  const { root, source, output } = await fixture();
  const outside = join(root, "outside.txt");
  await writeFile(outside, "do not follow");
  await symlink(outside, join(source, "escape.txt"));

  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        E2E_ARTIFACTS: source,
        E2E_SANITIZED_ARTIFACTS: output,
      },
    }),
    /symlink/,
  );
  await assert.rejects(lstat(output));
  assert.equal(await readFile(outside, "utf8"), "do not follow");
});

test("rejects non-sibling output roots before destructive replacement", async () => {
  const { root, source } = await fixture();
  const output = join(root, "nested", "safe");
  await writeFile(join(source, "proof.txt"), "source remains");

  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        E2E_ARTIFACTS: source,
        E2E_SANITIZED_ARTIFACTS: output,
      },
    }),
    /sibling directories/,
  );
  assert.equal(
    await readFile(join(source, "proof.txt"), "utf8"),
    "source remains",
  );
  await assert.rejects(lstat(output));
});

test("rejects special files", async (context) => {
  if (process.platform === "win32") {
    context.skip("mkfifo unavailable on Windows");
    return;
  }
  const { source, output } = await fixture();
  const fifo = join(source, "hostile.txt");
  await execFileAsync("mkfifo", [fifo]);
  await chmod(fifo, 0o600);

  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        E2E_ARTIFACTS: source,
        E2E_SANITIZED_ARTIFACTS: output,
      },
    }),
    /special file/,
  );
  await assert.rejects(lstat(output));
});

test("rejects unbounded artifact entry counts", async () => {
  const { source, output } = await fixture();
  await Promise.all(
    Array.from({ length: 501 }, (_, index) =>
      writeFile(join(source, `${index}.txt`), "bounded"),
    ),
  );

  await assert.rejects(
    execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        E2E_ARTIFACTS: source,
        E2E_SANITIZED_ARTIFACTS: output,
      },
    }),
    /500-entry limit/,
  );
  await assert.rejects(lstat(output));
});
