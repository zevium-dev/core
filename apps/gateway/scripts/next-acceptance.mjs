import { ConvexHttpClient } from "convex/browser";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";
const scratch = process.env.NEXT_TEST_SCRATCH;
assert.ok(scratch && scratch.includes("/.tmp/"));
const config = readFileSync(`${scratch}/.env.local`, "utf8");
const site = /^CONVEX_SITE_URL=(http:\/\/127\.0\.0\.1:\d+)/m.exec(config)?.[1];
assert.ok(site, "Anonymous loopback HTTP deployment required");
const clientUrl = /^CONVEX_URL=(http:\/\/127\.0\.0\.1:\d+)/m.exec(config)?.[1];
assert.ok(clientUrl);
const client = new ConvexHttpClient(clientUrl);
client.setAdminAuth(
  JSON.parse(
    readFileSync(`${scratch}/.convex/local/default/config.json`, "utf8"),
  ).adminKey,
);
async function convex(name, args = {}) {
  return name === "inspect"
    ? client.query(`edgeHarness:${name}`, args)
    : client.mutation(`edgeHarness:${name}`, args);
}
const ring = JSON.stringify({
  current: "k1",
  keys: { k1: "test-only-secret-never-use-in-production" },
});
let calls = 0,
  release,
  entered;
function waitForUpstream() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Upstream did not receive admitted request")),
      15_000,
    );
    entered = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}
const server = createServer(async (req, res) => {
  calls++;
  if (req.url.includes("slow")) {
    entered?.();
    await new Promise((resolve) => {
      release = resolve;
    });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const upstream = `http://127.0.0.1:${server.address().port}`;
const workerConfig = {
  name: "next-edge-acceptance",
  main: fileURLToPath(
    new URL("../test/fixtures/next-worker.ts", import.meta.url),
  ),
  compatibility_date: "2025-04-01",
  durable_objects: {
    bindings: [
      { name: "WALLET", class_name: "WalletSqliteDO" },
      { name: "EDGE_SNAPSHOTS", class_name: "EdgeSnapshotDO" },
      { name: "NEXT_WALLET", class_name: "NextWalletDO" },
    ],
  },
  migrations: [
    {
      tag: "test-v1",
      new_sqlite_classes: ["WalletSqliteDO", "EdgeSnapshotDO", "NextWalletDO"],
    },
  ],
};
writeFileSync(`${scratch}/worker.json`, JSON.stringify(workerConfig));
const persistPath = mkdtempSync(`${scratch}/worker-state-`);
const backend = spawn(
  "pnpm",
  ["exec", "convex", "dev", "--typecheck", "disable"],
  {
    cwd: scratch,
    env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
    // pnpm, the CLI and its local backend must all stop together.
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  },
);
backend.stderr.on("data", (chunk) => process.stderr.write(chunk));
let ready = false;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const r = await fetch(
      `${site}/edge-snapshot?kind=org&scope=missing&nonce=probe`,
      {
        headers: {
          "x-internal-secret": "test-only-internal-secret-never-production",
        },
      },
    );
    if (r.status === 200) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
let worker;
async function start() {
  worker = await unstable_dev(workerConfig.main, {
    config: `${scratch}/worker.json`,
    local: true,
    ip: "127.0.0.1",
    port: 0,
    persist: { path: persistPath },
    logLevel: "error",
    vars: {
      CONTROL_PLANE_MODE: "next",
      NEXT_DEPLOYMENT_ID: "next-fixture",
      NEXT_CONVEX_SITE_URL: site,
      NEXT_SNAPSHOT_KEYS: ring,
      NEXT_ADMISSION_KEYS: ring,
      NEXT_TRANSPORT_KEYS: ring,
      GATEWAY_INTERNAL_SECRET: "test-only-internal-secret-never-production",
      TEST_ORIGIN: upstream,
    },
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      watch: false,
    },
  });
}
const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${worker.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
};
const keyScope = (f) => createHash("sha256").update(f.secret).digest("hex");
async function warm(f) {
  for (const [kind, scope] of [
    ["keys", keyScope(f)],
    ["org", f.orgId],
    ["org", f.publisherOrgId],
    ["route", JSON.stringify([f.handle, "echo", f.orgId])],
  ])
    await post("/test/snapshot", { kind, scope });
  await post("/test/wallet", { orgId: f.orgId, action: "refresh" });
}
const call = (f) =>
  fetch(`http://127.0.0.1:${worker.port}/gateway/${f.handle}/echo/echo`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.secret}` },
  });
const flush = (f) =>
  post("/test/wallet", { orgId: f.orgId, action: "refresh" });
try {
  assert.ok(ready, "Persistent anonymous backend did not start");
  await start();
  const run = Date.now().toString(36);
  // A refund/archive can precede the wallet's first gateway request.
  const cold = await convex("seed", { run: `edge-cold-close-${run}` });
  await convex("close", { walletId: cold.walletId, id: "cold-close" });
  await post("/test/fault", { path: "/wallet-activate", count: 1 });
  const wake = await fetch(
    `http://127.0.0.1:${worker.port}/internal/next-wake`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-only-internal-secret-never-production",
      },
      body: JSON.stringify({
        clerkOrgId: cold.orgId,
        deploymentId: "next-fixture",
      }),
    },
  );
  assert.equal(wake.status, 202);
  for (let attempt = 0; attempt < 5; attempt++) {
    await flush(cold);
    if (
      (await convex("inspect", { walletId: cold.walletId })).wallet.close.ackAt
    )
      break;
  }
  const coldState = await convex("inspect", { walletId: cold.walletId });
  assert.ok(coldState.wallet.edgeBootstrapId);
  assert.ok(coldState.wallet.close.ackAt);
  assert.equal(coldState.wallet.close.edgeFinalSequence, 0);
  assert.equal(coldState.wallet.balance, 100);
  assert.equal(
    (await post("/test/fault", { path: "/wallet-activate", count: 0 }))[
      "/wallet-activate"
    ],
    1,
  );
  const f = await convex("seed", { run: `edge-normal-${run}` });
  assert.equal(
    (await call(f)).status,
    503,
    "cold authority refuses before upstream",
  );
  assert.equal(calls, 0);
  await warm(f);

  let r = await call(f);
  assert.equal(r.status, 200, await r.text());
  await flush(f);
  let state = await convex("inspect", { walletId: f.walletId });
  assert.equal(state.wallet.balance, 95);
  assert.equal(state.usage.length, 1);
  assert.equal(state.usage[0].credits, 5);
  assert.equal(
    state.earnings
      .filter((e) => e.projectId === f.project)
      .reduce((n, e) => n + e.netAtoms + e.platformFeeAtoms, 0),
    50_000,
  );
  // Freeze while a real upstream request is in flight. No ACK before its final.
  console.log("normal conservation passed");
  const slow = await convex("seed", { run: `edge-slow-${run}` });
  await warm(slow);
  const inFlight = waitForUpstream();
  const pending = fetch(
    `http://127.0.0.1:${worker.port}/gateway/${slow.handle}/echo/echo?slow`,
    { method: "POST", headers: { authorization: `Bearer ${slow.secret}` } },
  );
  pending.catch(() => {});
  await inFlight;
  console.log("upstream in flight");
  await convex("close", { walletId: slow.walletId, id: "close-inflight" });
  await flush(slow);
  state = await convex("inspect", { walletId: slow.walletId });
  assert.equal(state.wallet.close.ackAt, undefined);
  assert.equal((await call(slow)).status, 503);
  release();
  assert.equal((await pending).status, 200);
  await flush(slow);
  state = await convex("inspect", { walletId: slow.walletId });
  assert.equal(state.wallet.balance, 95);
  assert.equal(state.wallet.close.edgeFinalSequence, 1);
  assert.ok(state.wallet.close.ackAt);
  await convex("finish", { walletId: slow.walletId, id: "close-inflight" });
  await flush(slow);
  assert.equal((await call(slow)).status, 200);
  await flush(slow);
  console.log("inflight drain passed");
  // Stale authority cannot execute or synchronously refresh.
  await post("/test/snapshot", {
    kind: "keys",
    scope: keyScope(f),
    expire: true,
  });
  const before = calls;
  assert.equal((await call(f)).status, 503);
  assert.equal(calls, before);
  await warm(f);
  await convex("revoke", { keyId: f.keyId });
  await post("/test/snapshot", { kind: "keys", scope: keyScope(f) });
  assert.equal((await call(f)).status, 402);
  // Authentic admission with immutable evidence changed produces terminal exception.
  const bad = await convex("seed", { run: `edge-exception-${run}` });
  await warm(bad);
  const wait = waitForUpstream();
  const pendingBad = fetch(
    `http://127.0.0.1:${worker.port}/gateway/${bad.handle}/echo/echo?slow`,
    { method: "POST", headers: { authorization: `Bearer ${bad.secret}` } },
  );
  pendingBad.catch(() => {});
  await wait;
  await convex("poison", { keyId: bad.keyId });
  release();
  assert.equal((await pendingBad).status, 200);
  await flush(bad);
  state = await convex("inspect", { walletId: bad.walletId });
  assert.equal(state.wallet.balance, 100);
  assert.equal(state.usage[0].billingOutcome, "exception");
  assert.equal(state.wallet.settledThroughEdgeSequence, 1);
  console.log("exceptions passed");
  // Kill workerd after durable admission, while upstream has not returned.
  const crash = await convex("seed", { run: `edge-crash-${run}` });
  await warm(crash);
  const crashWait = waitForUpstream();
  const lost = fetch(
    `http://127.0.0.1:${worker.port}/gateway/${crash.handle}/echo/echo?slow`,
    { method: "POST", headers: { authorization: `Bearer ${crash.secret}` } },
  ).catch(() => null);
  await crashWait;
  await worker.stop();
  release();
  await lost;
  await start();
  await post("/test/wallet", { orgId: crash.orgId, action: "expire" });
  await flush(crash);
  state = await convex("inspect", { walletId: crash.walletId });
  assert.equal(state.usage.length, 1);
  assert.equal(state.usage[0].billingOutcome, "exception");
  assert.equal(state.wallet.balance, 100);
  await convex("close", { walletId: crash.walletId, id: "close-restart" });
  await flush(crash);
  state = await convex("inspect", { walletId: crash.walletId });
  assert.ok(state.wallet.close.ackAt);
  const depleted = await convex("seed", { run: `edge-depleted-${run}` });
  await warm(depleted);
  const depletedWait = waitForUpstream();
  const depletedCall = fetch(
    `http://127.0.0.1:${worker.port}/gateway/${depleted.handle}/echo/echo?slow`,
    { method: "POST", headers: { authorization: `Bearer ${depleted.secret}` } },
  );
  depletedCall.catch(() => {});
  await depletedWait;
  await convex("deplete", { walletId: depleted.walletId });
  release();
  assert.equal((await depletedCall).status, 200);
  await flush(depleted);
  state = await convex("inspect", { walletId: depleted.walletId });
  assert.equal(state.wallet.balance, 0);
  assert.equal(state.usage[0].billingOutcome, "exception");
  await convex("close", { walletId: depleted.walletId, id: "depleted-close" });
  await flush(depleted);
  assert.ok(
    (await convex("inspect", { walletId: depleted.walletId })).wallet.close
      .ackAt,
  );
  const replay = await convex("seed", { run: `edge-replay-${run}` });
  await warm(replay);
  await post("/test/fault", { path: "/ingest-usage", count: 1 });
  assert.equal((await call(replay)).status, 200);
  await flush(replay);
  await flush(replay);
  state = await convex("inspect", { walletId: replay.walletId });
  assert.equal(state.wallet.balance, 95);
  assert.equal(state.usage.length, 1);
  assert.equal(
    (await post("/test/fault", { path: "/ingest-usage", count: 0 }))[
      "/ingest-usage"
    ],
    1,
  );
  await convex("close", { walletId: replay.walletId, id: "lost-drain" });
  await post("/test/fault", { path: "/wallet-drain", count: 1 });
  await flush(replay);
  const firstAck = (await convex("inspect", { walletId: replay.walletId }))
    .wallet.close.ackFingerprint;
  assert.ok(firstAck);
  await worker.stop();
  await start();
  await flush(replay);
  assert.equal(
    (await convex("inspect", { walletId: replay.walletId })).wallet.close
      .ackFingerprint,
    firstAck,
  );
  const queued = await convex("seed", {
    run: `edge-queued-${run}`,
    paid: true,
  });
  await warm(queued);
  const queuedWait = waitForUpstream();
  const queuedCall = fetch(
    `http://127.0.0.1:${worker.port}/gateway/${queued.handle}/echo/echo?slow`,
    { method: "POST", headers: { authorization: `Bearer ${queued.secret}` } },
  );
  queuedCall.catch(() => {});
  await queuedWait;
  await convex("close", { walletId: queued.walletId, id: "busy-close" });
  assert.equal(
    await convex("refund", { paymentId: queued.paymentId }),
    "waiting",
  );
  await flush(queued);
  release();
  assert.equal((await queuedCall).status, 200);
  await flush(queued);
  await convex("finish", { walletId: queued.walletId, id: "busy-close" });
  let done = false;
  for (let page = 0; page < 30; page++) {
    await flush(queued);
    const result = await convex("advanceRefund", {
      paymentId: queued.paymentId,
    });
    if (result === "done") {
      done = true;
      break;
    }
  }
  assert.ok(done, "Queued refund must finish after real drain");
  state = await convex("inspect", { walletId: queued.walletId });
  assert.equal(state.wallet.balance, 0);
  assert.equal(state.usage[0].credits, 5);
  assert.equal(
    state.earnings
      .filter((e) => e.projectId === queued.project)
      .reduce((n, e) => n + e.clawedBackGrossCredits, 0),
    5,
  );
  const closed = await convex("seed", {
    run: `edge-closed-${run}`,
    paid: true,
  });
  await warm(closed);
  await convex("archive", { walletId: closed.walletId });
  await flush(closed);
  await convex("finish", {
    walletId: closed.walletId,
    id: `archive:${closed.walletId}`,
  });
  await flush(closed);
  await convex("refund", { paymentId: closed.paymentId });
  for (let page = 0; page < 30; page++) {
    await flush(closed);
    if (
      (await convex("advanceRefund", { paymentId: closed.paymentId })) ===
      "done"
    )
      break;
  }
  await flush(closed);
  state = await convex("inspect", { walletId: closed.walletId });
  assert.equal(state.wallet.gateState, "closed");
  assert.equal(state.wallet.balance, 0);
  const local = await post("/test/wallet", {
    orgId: closed.orgId,
    action: "inspect",
  });
  assert.equal(JSON.parse(local.state[0].data).checkpoint.gateState, "closed");
  console.log(
    "PR5 real Worker + anonymous Convex acceptance passed: conservation, in-flight drain, stale/revoked key, exception, restart/drain.",
  );
} finally {
  release?.();
  await worker?.stop();
  if (backend.exitCode === null && backend.signalCode === null) {
    const stopped = new Promise((resolve) => backend.once("exit", resolve));
    if (process.platform === "win32") backend.kill("SIGTERM");
    else process.kill(-backend.pid, "SIGTERM");
    await stopped;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
