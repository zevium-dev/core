import { createFileRoute, Link } from "@tanstack/react-router";
import {
  MAX_DAILY_FREE_TIER_CALLS,
  MAX_ENDPOINT_COST_CREDITS,
} from "@zevium/shared";

import { DocsCodeBlock } from "#/components/docs-code-block";
import { DocsPage } from "#/components/docs-layout";

export const Route = createFileRoute("/docs/publishing")({
  head: () => ({
    meta: [
      { title: "Publishing · Zevium Docs" },
      {
        name: "description",
        content:
          "Publish an API on Zevium: OpenAPI spec, per-endpoint pricing, semver versions, webhooks.",
      },
    ],
  }),
  component: DocsPublishingPage,
});

const SPEC_EXAMPLE = `openapi: 3.1.0
info:
  title: Summarize API
  version: 1.0.0
servers:
  - url: https://api.acme.dev
paths:
  /health:
    head:
      summary: Credential-free readiness check
      x-zevium-cost: 0
      x-zevium-health-check: true
  /v1/summarize:
    post:
      summary: Summarize text
      x-zevium-cost: 10        # credits per call; omit to hide
      x-zevium-free-tier: 5    # optional: free calls/day, publisher-funded
  /v1/keywords:
    post:
      summary: Extract keywords
      x-zevium-cost: 2`;

const VERIFY_WEBHOOK = `import crypto from "node:crypto";

// 1. Read the RAW body before JSON.parse — the signature is over exact bytes.
const body = await request.text();
const signature = request.headers.get("x-zevium-signature");
const deliveryHeader = request.headers.get("x-zevium-delivery-id");

// 2. Recompute HMAC-SHA256(secret, body) → lowercase hex.
const expected = crypto
  .createHmac("sha256", process.env.ZEVIUM_WEBHOOK_SECRET)
  .update(body)
  .digest("hex");

// 3. Timing-safe compare; reject if missing or mismatched.
const a = Buffer.from(signature ?? "");
const b = Buffer.from(expected);
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  return new Response("Invalid signature", { status: 401 });
}

// 4. Enforce signed replay fields. Zevium timestamps use epoch milliseconds.
const { id, event, data, timestamp } = JSON.parse(body);
if (
  typeof id !== "string" ||
  id !== deliveryHeader ||
  !Number.isSafeInteger(timestamp) ||
  Math.abs(Date.now() - timestamp) > 5 * 60_000
) {
  return new Response("Expired or invalid delivery", { status: 400 });
}

// 5. Atomically claim id before side effects; retain it beyond your replay window.
const claimed = await redis.set("zevium:webhook:" + id, "1", {
  NX: true,
  EX: 24 * 60 * 60,
});
if (claimed !== "OK") return new Response(null, { status: 200 });

console.log(event, data, timestamp);`;

function DocsPublishingPage() {
  return (
    <DocsPage
      title="Publishing"
      description="List your API with an OpenAPI spec and earn 95% of each successful paid call. Zevium handles prepaid billing."
    >
      <h2>The model</h2>
      <p>
        Each API is a <strong>project</strong> owned by an organization. Its
        OpenAPI spec defines the upstream address, request and response shapes,
        and each endpoint’s price. Start with a draft, test the health endpoint,
        then publish a version.
      </p>
      <ol>
        <li>
          <strong>Create a project.</strong> From{" "}
          <Link to="/app/projects">Projects</Link>, create a project and open
          the spec editor.
        </li>
        <li>
          <strong>Add pricing.</strong> Add <code>x-zevium-cost</code> to each
          operation you want to expose. Unpriced operations stay hidden and
          cannot be called; set it to 0 for free calls. Optionally add{" "}
          <code>x-zevium-free-tier</code>.
        </li>
        <li>
          <strong>Attach upstream credentials.</strong> In project settings, add
          the secrets the gateway injects on forwarded calls so authenticated
          upstream APIs work without exposing keys to consumers.
        </li>
        <li>
          <strong>Declare and test health.</strong> Mark exactly one safe,
          parameter-free <code>GET</code> or <code>HEAD</code> with{" "}
          <code>x-zevium-health-check: true</code>. It must return 2xx/3xx
          without publisher or consumer credentials.
        </li>
        <li>
          <strong>Validate and publish.</strong> Fix validation errors and pass
          the saved draft’s health check. Publish a semver version (e.g.{" "}
          <code>0.1.0</code>) and make it public.
        </li>
      </ol>

      <h2>Pricing in the spec</h2>
      <p>
        Pricing is declared as OpenAPI vendor extensions on each path operation:
      </p>
      <DocsCodeBlock lang="yaml" code={SPEC_EXAMPLE} />
      <ul>
        <li>
          <code>x-zevium-cost</code> — credits per call. Integer from 0 to{" "}
          {MAX_ENDPOINT_COST_CREDITS.toLocaleString("en-US")}. Defaults to 1
          when absent.
        </li>
        <li>
          <code>x-zevium-free-tier</code> — optional free calls per day,
          <strong> publisher-funded</strong>, capped at{" "}
          {MAX_DAILY_FREE_TIER_CALLS.toLocaleString("en-US")}. The platform does
          not subsidize free-tier calls.
        </li>
        <li>
          <code>x-zevium-health-check</code> — required on exactly one safe
          credential-free <code>GET</code> or <code>HEAD</code>. A passing
          health check shows that this endpoint is reachable. Success rates for
          other operations are measured separately from gateway calls.
        </li>
      </ul>
      <p>
        For example, 10 credits costs the consumer $0.001 per successful call.
        Choose a price that covers your upstream costs and the 5% platform
        share.
      </p>

      <h2>Immutability</h2>
      <p>
        Published specs cannot be edited. Save changes as a draft and publish a
        new semver version. The gateway uses the latest published version, so
        check compatibility before publishing changes that affect existing
        consumers.
      </p>

      <h2>Deprecation</h2>
      <p>
        Deprecate a version to add a migration notice and an optional migration
        date at least seven days away. This date is informational. To stop live
        calls, schedule project retirement in Settings with at least seven days’
        notice. The API leaves new discovery, while existing consumers can call
        it until the project’s sunset. Responses then include headers such as:
      </p>
      <DocsCodeBlock
        lang="http"
        code={`Deprecation: @1735689600
Link: <https://zevium.dev/catalogue/acme/summarize>; rel="deprecation"
Sunset: Wed, 31 Dec 2025 23:59:59 GMT`}
      />

      <h2>Webhooks</h2>
      <p>
        Add one HTTPS webhook endpoint in project Settings. Zevium signs every
        delivery with HMAC-SHA256. Current events:
      </p>
      <ul>
        <li>
          <code>spec.published</code> — a new version published.
        </li>
        <li>
          <code>spec.deprecated</code> — a version deprecated (with an optional{" "}
          <code>sunsetAt</code> migration date).
        </li>
        <li>
          <code>project.deprecated</code> — project retirement scheduled.
        </li>
        <li>
          <code>project.deprecation_canceled</code> — scheduled project
          retirement canceled.
        </li>
        <li>
          <code>project.visibility_changed</code> — project made public or
          private by its publisher or a Zevium admin. The <code>data</code>{" "}
          payload contains <code>projectId</code> and <code>visibility</code> (
          <code>public</code> or <code>private</code>). Updates that leave
          visibility unchanged do not emit this event.
        </li>
      </ul>
      <p>Each delivery is a POST with these headers and a JSON body:</p>
      <DocsCodeBlock
        lang="http"
        code={`POST /your/webhook HTTP/1.1
Content-Type: application/json
x-zevium-event: spec.published
x-zevium-delivery-id: <stable delivery id>
x-zevium-signature: <hex HMAC-SHA256 of body>

{"id":"<same stable delivery id>","event":"spec.published","data":{"projectId":"...","version":"0.1.0"},"timestamp":1735689600000}`}
      />
      <p>
        Verify the signature against the raw body, check the signed timestamp
        and delivery ID, then deduplicate deliveries before applying changes.
        Zevium generates the signing secret when you create the endpoint.
        Organization admins can reveal it in project Settings:
      </p>
      <DocsCodeBlock lang="typescript" code={VERIFY_WEBHOOK} />
    </DocsPage>
  );
}
