import { test } from "node:test";
import assert from "node:assert/strict";
import { guardDev } from "./guard-dev.mjs";
import { preflightRelease } from "./preflight-release.mjs";

const noRead = () => {
  throw new Error("Unexpected provider read");
};
test("dev permits isolated backends without network reads", () => {
  for (const target of ["anonymous:fixture", "local:fixture"])
    guardDev({ CONVEX_DEPLOYMENT: target }, noRead);
  guardDev(
    {
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "fixture",
    },
    noRead,
  );
});
test("dev rejects unselected, production, overridden local and legacy shared targets", () => {
  for (const env of [
    {},
    { CONVEX_DEPLOYMENT: "prod:fixture" },
    { CONVEX_DEPLOYMENT: "anonymous:fixture", CONVEX_DEPLOY_KEY: "fixture" },
    {
      CONVEX_DEPLOYMENT: "anonymous:fixture",
      CONVEX_DEPLOYMENT_TOKEN: "fixture",
    },
    {
      CONVEX_SELF_HOSTED_URL: "https://remote.invalid",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "fixture",
    },
  ])
    assert.throws(() => guardDev(env, noRead), /Refusing Convex dev/);
  for (const marker of [
    { status: 0, stdout: "" },
    { status: 1, stdout: "" },
    { status: null, stdout: "" },
  ])
    assert.throws(
      () => guardDev({ CONVEX_DEPLOYMENT: "dev:legacy" }, () => marker),
      /convex-activation.md/,
    );
  guardDev({ CONVEX_DEPLOYMENT: "dev:rebuilt" }, () => ({
    status: 0,
    stdout: "paired-id\n",
  }));
});
const release = (patch = {}) => ({
  gatewayUrl: "https://gateway.fixture.invalid",
  deploymentId: "fixture",
  fetchHealth: async () =>
    Response.json({ ok: true, service: "zevium-gateway", contract: 2 }),
  readMarker: () => ({ status: 0, stdout: "fixture\n" }),
  ...patch,
});
test("release permits only healthy contract 2 and unset-or-matching marker", async () => {
  await preflightRelease(release());
  await preflightRelease(
    release({ readMarker: () => ({ status: 0, stdout: "" }) }),
  );
  for (const body of [
    { ok: true, service: "zevium-gateway" },
    { ok: true, service: "zevium-gateway", contract: "2" },
    { ok: false, service: "zevium-gateway", contract: 2 },
  ])
    await assert.rejects(
      preflightRelease(
        release({
          fetchHealth: async () => Response.json(body),
          readMarker: noRead,
        }),
      ),
      /contract 2/,
    );
  await assert.rejects(
    preflightRelease(
      release({
        fetchHealth: async () => new Response(null, { status: 503 }),
        readMarker: noRead,
      }),
    ),
    /unavailable/,
  );
  for (const stdout of ["another", "fixture \n", "\n"])
    await assert.rejects(
      preflightRelease(release({ readMarker: () => ({ status: 0, stdout }) })),
      /mismatch/,
    );
  await assert.rejects(
    preflightRelease(
      release({ readMarker: () => ({ status: 1, stdout: "" }) }),
    ),
    /Cannot verify/,
  );
  await assert.rejects(
    preflightRelease(release({ deploymentId: "" })),
    /required/,
  );
});
