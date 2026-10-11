import { ConvexHttpClient } from "convex/browser";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unstable_dev, unstable_readConfig } from "wrangler";
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
const oauthTokens = new Map();
let oauthReads = 0;
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
  if (req.url === "/v1/oauth_applications/access_tokens/verify") {
    oauthReads++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const identity = oauthTokens.get(JSON.parse(body).access_token);
    res.writeHead(identity ? 200 : 400, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        identity
          ? {
              subject: identity.ownerUserId,
              revoked: false,
              expired: false,
              expiration: Math.floor(Date.now() / 1000) + 3600,
              scopes: ["user:org:read", "zevium:mcp:execute"],
              aud: ["https://gateway.test/mcp"],
            }
          : {},
      ),
    );
    return;
  }
  if (req.url === "/oauth/userinfo") {
    const identity = oauthTokens.get(req.headers.authorization?.slice(7));
    res.writeHead(identity ? 200 : 401, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        identity ? { sub: identity.ownerUserId, org_id: identity.orgId } : {},
      ),
    );
    return;
  }
  calls++;
  if (req.url.includes("oversized")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(1_048_577));
    return;
  }
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
const productionConfig = unstable_readConfig({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
});
assert.ok(productionConfig.migrations.some((m) => m.tag === "v5-next-edge"));
const workerConfig = {
  name: "next-edge-acceptance",
  main: fileURLToPath(
    new URL("../test/fixtures/next-worker.ts", import.meta.url),
  ),
  compatibility_date: "2025-04-01",
  durable_objects: productionConfig.durable_objects,
  migrations: productionConfig.migrations,
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
    port: process.env.CUTOVER_BROWSER === "1" ? 8787 : 0,
    persist: { path: persistPath },
    logLevel: "error",
    vars: {
      APP_ORIGIN: "http://localhost:3000",
      NEXT_DEPLOYMENT_ID: "next-fixture",
      CONVEX_SITE_URL: site,
      NEXT_SNAPSHOT_KEYS: ring,
      NEXT_ADMISSION_KEYS: ring,
      NEXT_TRANSPORT_KEYS: ring,
      GATEWAY_INTERNAL_SECRET: "test-only-internal-secret-never-production",
      TEST_ORIGIN: upstream,
      CLERK_SECRET_KEY: "test-only-clerk-secret",
      MCP_OAUTH_ISSUER: "https://clerk.invalid",
      MCP_OAUTH_RESOURCE: "https://gateway.test/mcp",
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
const call = (f) =>
  fetch(`http://127.0.0.1:${worker.port}/gateway/${f.handle}/echo/echo`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.secret}` },
  });
const flush = (f) =>
  post("/test/wallet", { orgId: f.orgId, action: "refresh" });
async function waitDrain(f) {
  // Alarms can overlap explicit refresh RPCs; only the durable ACK proves drain.
  for (let attempt = 0; attempt < 40; attempt++) {
    await flush(f);
    const state = await convex("inspect", { walletId: f.walletId });
    if (state.wallet.close?.ackAt) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(
    "Durable drain acknowledgement did not arrive within the bounded wait",
  );
}
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
  // Actual OAuth DO binding, provider HTTP seam, Convex identity and metered MCP call.
  const oauth = await convex("seed", { run: `edge-oauth-${run}` });
  const bearer = `oat_${randomBytes(32).toString("hex")}`;
  oauthTokens.set(bearer, oauth);
  const mcp = (token) =>
    fetch(`http://127.0.0.1:${worker.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "call_api",
          arguments: {
            org: oauth.handle,
            project: "echo",
            method: "POST",
            path: "/echo",
          },
        },
      }),
    });
  let oauthResponse = await mcp(bearer);
  assert.equal(oauthResponse.status, 200, await oauthResponse.clone().text());
  assert.equal((await oauthResponse.json()).result.isError, undefined);
  await flush(oauth);
  assert.equal(
    (await convex("inspect", { walletId: oauth.walletId })).wallet.balance,
    95,
  );
  const verifiedReads = oauthReads;
  oauthResponse = await mcp(bearer);
  assert.equal(oauthResponse.status, 200);
  assert.equal(oauthReads, verifiedReads, "Warm OAuth does not contact Clerk");
  const invalid = `oat_${"z".repeat(32)}`;
  assert.equal((await mcp(invalid)).status, 401);
  const negativeReads = oauthReads;
  assert.equal((await mcp(invalid)).status, 401);
  assert.equal(oauthReads, negativeReads, "Invalid opaque token is cached");
  await flush(oauth);
  // Public mock never contacts upstream; direct HTTP streams large responses,
  // while MCP refuses its bounded buffer and restores the source reservation.
  const safe = await convex("seed", { run: `edge-buffer-${run}` });
  const beforeMock = calls;
  const mock = await fetch(
    `http://127.0.0.1:${worker.port}/mock/${safe.handle}/echo/echo`,
    { method: "POST" },
  );
  assert.equal(mock.status, 200, await mock.clone().text());
  assert.equal(calls, beforeMock);
  const large = await fetch(
    `http://127.0.0.1:${worker.port}/gateway/${safe.handle}/echo/echo?oversized`,
    { method: "POST", headers: { authorization: `Bearer ${safe.secret}` } },
  );
  assert.equal(large.status, 200);
  assert.equal((await large.text()).length, 1_048_577);
  await flush(safe);
  assert.equal(
    (await convex("inspect", { walletId: safe.walletId })).wallet.balance,
    95,
  );
  const oversized = await fetch(`http://127.0.0.1:${worker.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${safe.secret}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "call_api",
        arguments: {
          org: safe.handle,
          project: "echo",
          method: "POST",
          path: "/echo?oversized",
        },
      },
    }),
  });
  assert.equal((await oversized.json()).result.isError, true);
  await flush(safe);
  assert.equal(
    (await convex("inspect", { walletId: safe.walletId })).wallet.balance,
    95,
  );
  const empty = await convex("seed", {
    run: `edge-empty-${run}`,
    amounts: [1],
  });
  await convex("deplete", { walletId: empty.walletId });
  const beforeEmpty = calls;
  assert.equal((await call(empty)).status, 402);
  assert.equal(calls, beforeEmpty);
  // Freeze while a real upstream request is in flight. No ACK before its final.
  console.log("normal conservation passed");
  const slow = await convex("seed", { run: `edge-slow-${run}` });
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
  await waitDrain(slow);
  state = await convex("inspect", { walletId: slow.walletId });
  assert.equal(state.wallet.balance, 95);
  assert.equal(state.wallet.close.edgeFinalSequence, 1);
  assert.ok(state.wallet.close.ackAt);
  const installedBefore = JSON.parse(
    (await post("/test/wallet", { orgId: slow.orgId, action: "pause" }))
      .state[0].data,
  );
  assert.equal(installedBefore.sealed, true);
  assert.equal(installedBefore.checkpoint.gateState, "closing");
  assert.ok(installedBefore.checkpoint.validUntil > Date.now());
  await convex("finish", { walletId: slow.walletId, id: "close-inflight" });
  const reopenedCall = await call(slow);
  console.log("Immediate post-finish admission status", reopenedCall.status);
  assert.equal(reopenedCall.status, 200);
  const installedAfter = JSON.parse(
    (await post("/test/wallet", { orgId: slow.orgId, action: "inspect" }))
      .state[0].data,
  );
  assert.equal(
    installedAfter.checkpoint.epoch,
    installedBefore.checkpoint.epoch + 1,
  );
  assert.equal(installedAfter.checkpoint.gateState, "open");
  assert.equal(installedAfter.sealed, false);
  await flush(slow);
  console.log("inflight drain passed");
  // Expired authority fails closed when the bounded cold refresh fails.
  await post("/test/snapshot", {
    kind: "keys",
    scope: keyScope(f),
    expire: true,
  });
  const before = calls;
  await post("/test/fault", { path: "/edge-snapshot", count: 1 });
  assert.equal((await call(f)).status, 503);
  assert.equal(calls, before);
  await convex("revoke", { keyId: f.keyId });
  await post("/test/snapshot", { kind: "keys", scope: keyScope(f) });
  assert.equal((await call(f)).status, 402);
  // Authentic admission with immutable evidence changed produces terminal exception.
  const bad = await convex("seed", { run: `edge-exception-${run}` });
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
  // Lock only after an admitted call settles; survive restart with other funding usable.
  const scoped = await convex("seed", {
    run: `edge-scoped-${run}`,
    paid: true,
  });
  const scopedEntered = waitForUpstream();
  const scopedCall = fetch(
    `http://127.0.0.1:${worker.port}/gateway/${scoped.handle}/echo/echo?slow`,
    { method: "POST", headers: { authorization: `Bearer ${scoped.secret}` } },
  );
  const scopedEarly = await Promise.race([
    scopedEntered.then(() => null),
    scopedCall,
  ]);
  assert.equal(
    scopedEarly,
    null,
    `Scoped admission failed: ${scopedEarly?.status}`,
  );
  await convex("review", { paymentId: scoped.paymentId });
  assert.equal(
    await convex("advanceRefund", { paymentId: scoped.paymentId }),
    "waiting",
  );
  release();
  assert.equal((await scopedCall).status, 200);
  await waitDrain(scoped);
  assert.equal(
    await convex("advanceRefund", { paymentId: scoped.paymentId }),
    "done",
  );
  state = await convex("inspect", { walletId: scoped.walletId });
  assert.equal(state.wallet.gateState, "open");
  assert.equal(state.wallet.lockedCredits, 99995);
  assert.equal(state.wallet.balance, 99995);
  const blockedCalls = calls;
  const lockedResponse = await call(scoped);
  console.log("Immediate scoped reopen status", lockedResponse.status);
  assert.equal(lockedResponse.status, 402);
  assert.equal(calls, blockedCalls);
  const unrelatedPayment = await convex("reviewCredits", {
    walletId: scoped.walletId,
  });
  await flush(scoped);
  assert.equal((await call(scoped)).status, 200); // promotional source
  await flush(scoped);
  await worker.stop();
  await start();
  const restarted = await call(scoped);
  console.log("Restart cold admission status", restarted.status);
  assert.equal(restarted.status, 200); // unrelated paid source after SQLite restart
  await flush(scoped);
  state = await convex("inspect", { walletId: scoped.walletId });
  assert.equal(state.wallet.lockedCredits, 99995);
  assert.equal(state.wallet.balance, 100090);
  assert.equal(state.usage.length, 3);
  assert.equal(state.usage[2].fundingSlices[0].paymentId, unrelatedPayment);
  assert.ok(
    state.cases.some(
      (c) =>
        c.rowKind === "case" &&
        c.paymentId === scoped.paymentId &&
        c.status === "open",
    ),
  );
  console.log(
    "Scoped payment quarantine, in-flight settlement and restart passed",
  );
  // Kill workerd after durable admission, while upstream has not returned.
  const crash = await convex("seed", { run: `edge-crash-${run}` });
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
  state = await waitDrain(crash);
  assert.ok(state.wallet.close.ackAt);
  const depleted = await convex("seed", { run: `edge-depleted-${run}` });
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
  await waitDrain(depleted);
  assert.ok(
    (await convex("inspect", { walletId: depleted.walletId })).wallet.close
      .ackAt,
  );
  const replay = await convex("seed", { run: `edge-replay-${run}` });
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
  await waitDrain(replay);
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
  await waitDrain(queued);
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
  await convex("archive", { walletId: closed.walletId });
  await waitDrain(closed);
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
    "PR5 real Worker + anonymous Convex acceptance passed: cold key/wallet/OAuth, production migrations, conservation, in-flight drain, stale/revoked key, exception, restart/drain.",
  );
  // Optional local browser lane. Same guarded anonymous backend and real Worker;
  // credentials remain in ignored files, never in CI artifacts or console output.
  if (process.env.CUTOVER_BROWSER === "1") {
    const fixture = await convex("seed", {
      run: `browser-${run}`,
      house: true,
    });
    writeFileSync(
      `${scratch}/browser-runtime.json`,
      JSON.stringify({
        clientUrl,
        site,
        gateway: `http://127.0.0.1:${worker.port}`,
        fixture,
      }),
      { mode: 0o600 },
    );
    console.log("Browser lane ready; guarded runtime file written in scratch.");
    const deadline = Date.now() + 30 * 60_000;
    while (!existsSync(`${scratch}/browser-done`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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
