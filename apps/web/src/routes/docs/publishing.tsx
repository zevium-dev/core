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
  /v1/summarize:
    post:
      summary: Summarize text
      x-zevium-cost: 10        # credits per call (default 1)
      x-zevium-free-tier: 5    # optional: free calls/day, publisher-funded
  /v1/keywords:
    post:
      summary: Extract keywords
      x-zevium-cost: 2`;

const VERIFY_WEBHOOK = `import crypto from "node:crypto";

// 1. Read the RAW body before JSON.parse — the signature is over exact bytes.
const body = await request.text();
const signature = request.headers.get("x-zevium-signature");

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

// 4. Now safe to parse.
const { event, data, timestamp } = JSON.parse(body);
console.log(event, data, timestamp);`;

function DocsPublishingPage() {
  return (
    <DocsPage
      title="Publishing"
      description="Publish a paid API in minutes: declare pricing in the OpenAPI spec, validate, publish a semver version, make it public. No billing infrastructure required."
    >
      <h2>The model</h2>
      <p>
        Each API is a <strong>project</strong> owned by an org. The project's
        OpenAPI spec is the single source of truth for the upstream address,
        available endpoints, and per-endpoint pricing. There are no parallel
        pricing tables — the spec is the product.
      </p>
      <ol>
        <li>
          <strong>Create a project.</strong> From{" "}
          <Link to="/app/projects">Projects</Link>, create a project and open
          the spec editor.
        </li>
        <li>
          <strong>Add pricing.</strong> Add <code>x-zevium-cost</code> to each
          operation (defaults to 1 credit when omitted). Optionally add{" "}
          <code>x-zevium-free-tier</code>.
        </li>
        <li>
          <strong>Attach upstream credentials.</strong> In project settings, add
          the secrets the gateway injects on forwarded calls so authenticated
          upstream APIs work without exposing keys to consumers.
        </li>
        <li>
          <strong>Validate and publish.</strong> Fix errors, then publish a
          semver version (e.g. <code>0.1.0</code>).
        </li>
        <li>
          <strong>Make public.</strong> Flip visibility to public; automated
          gates (spec valid, upstream reachable) run, then the API lists in the
          catalogue.
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
      </ul>
      <p>
        Production agent-tool pricing clusters at 20–500 credits per call
        ($0.002–$0.05). Agents loop on the cheapest useful endpoint — price for
        machine volume.
      </p>

      <h2>Immutability</h2>
      <p>
        A published version is immutable. To change an API, publish a new semver
        version. Consumers integrate against a specific version; nothing shifts
        under them.
      </p>

      <h2>Deprecation</h2>
      <p>
        A publisher cannot silently kill an API with active consumers.
        Deprecating a version sets a sunset date, freezes new subscriptions, and
        signals consumers on every response:
      </p>
      <DocsCodeBlock
        lang="http"
        code={`Deprecation: @1735689600
Link: <https://zevium.dev/catalogue/acme/summarize>; rel="deprecation"
Sunset: Wed, 31 Dec 2025 23:59:59 GMT`}
      />

      <h2>Webhooks</h2>
      <p>
        Add an HTTPS endpoint per project (one per project). Zevium signs every
        delivery with HMAC-SHA256. Current events:
      </p>
      <ul>
        <li>
          <code>spec.published</code> — a new version published.
        </li>
        <li>
          <code>spec.deprecated</code> — a version deprecated (with{" "}
          <code>sunsetAt</code>).
        </li>
        <li>
          <code>project.visibility_changed</code> — project made public or
          private.
        </li>
      </ul>
      <p>Each delivery is a POST with these headers and a JSON body:</p>
      <DocsCodeBlock
        lang="http"
        code={`POST /your/webhook HTTP/1.1
Content-Type: application/json
x-zevium-event: spec.published
x-zevium-signature: <hex HMAC-SHA256 of body>

{"event":"spec.published","data":{"projectId":"...","version":"0.1.0"},"timestamp":1735689600000}`}
      />
      <p>
        Verify the signature before trusting the payload. The signing secret is
        generated server-side when you create the endpoint and shown once:
      </p>
      <DocsCodeBlock lang="typescript" code={VERIFY_WEBHOOK} />
    </DocsPage>
  );
}
