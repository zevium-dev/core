import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

test("Wrangler dev uses the configured local discovery origin, not the production route", async (t) => {
  const worker = await unstable_dev(
    fileURLToPath(
      new URL("../test/fixtures/discovery-origin-worker.ts", import.meta.url),
    ),
    {
      config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      ip: "127.0.0.1",
      port: 0,
      local: true,
      persist: false,
      logLevel: "error",
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
      },
    },
  );
  t.after(() => worker.stop());
  // Use the listening socket, not Wrangler's fetch helper: exercise route rewrites.
  const origin = `http://127.0.0.1:${worker.port}`;
  const response = await fetch(`${origin}/discovery`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apis.length, 1);
  assert.equal(
    body.apis[0].gatewayBaseUrl,
    "http://localhost:8787/gateway/test-publisher/test-api",
  );
});
