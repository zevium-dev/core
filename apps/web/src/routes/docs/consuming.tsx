import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsCodeBlock } from "#/components/docs-code-block";
import { DocsPage } from "#/components/docs-layout";
import { resolveGatewayOrigin } from "#/lib/landing";

export const Route = createFileRoute("/docs/consuming")({
  head: () => ({
    meta: [
      { title: "Consuming · Zevium Docs" },
      {
        name: "description",
        content:
          "Call APIs through the Zevium gateway: keys, URL shape, response headers, refunds.",
      },
    ],
  }),
  component: DocsConsumingPage,
});

const GATEWAY = resolveGatewayOrigin(
  import.meta.env.VITE_GATEWAY_URL as string | undefined,
);

const CALL_EXAMPLE = `ZEVIUM_API_KEY="paste-your-key-here"
curl "${GATEWAY}/gateway/acme/summarize/v1/summarize" \\
  --oauth2-bearer "$ZEVIUM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Agent-first API marketplace."}'`;

const RESPONSE_HEADERS = `HTTP/1.1 200 OK
content-type: application/json
x-zevium-request-id: 7f3c1a2b-9d4e-4a6c-8b1f-0e5d2a7c3f9b
x-zevium-cost: 10`;

const INSUFFICIENT = `{
  "error": "insufficient_credits",
  "message": "Insufficient credits",
  "requestId": "7f3c1a2b-9d4e-4a6c-8b1f-0e5d2a7c3f9b",
  "available": 3,
  "cost": 10
}`;

function DocsConsumingPage() {
  return (
    <DocsPage
      title="Consuming"
      description="Every call is one key, one gateway URL, one wallet. Authenticate, hit the gateway, read the metering headers. Failed calls cost nothing."
    >
      <h2>API keys</h2>
      <p>
        Keys are <strong>org-scoped</strong>. The org owns the wallet; each
        member's key draws from it with per-key attribution. Create one from{" "}
        <Link to="/app/settings/keys">Settings → Keys</Link>:
      </p>
      <ul>
        <li>
          One key per user per org. Revoke the existing key before creating a
          new one.
        </li>
        <li>
          The secret (prefix <code>ak_</code>) is shown <strong>once</strong> at
          creation. Store it immediately.
        </li>
        <li>
          Per-key monthly spend caps and zero-downtime rotation (24h grace on
          the old key) are enforced at the gateway. Daily/weekly reset windows
          are on the roadmap.
        </li>
      </ul>

      <h2>Calling through the gateway</h2>
      <p>The gateway URL shape is fixed:</p>
      <DocsCodeBlock
        lang="text"
        code={`${GATEWAY}/gateway/{org}/{project}/{path}

org     — publisher org slug (from the catalogue URL)
project — API / project slug
path    — endpoint path from the spec (e.g. /v1/summarize)`}
      />
      <p>
        Authenticate with the key in the <code>Authorization</code> header
        (Bearer) or <code>x-api-key</code>. Query string and body pass through
        to the upstream unchanged:
      </p>
      <DocsCodeBlock lang="bash" code={CALL_EXAMPLE} />

      <h2>Mock calls (no key needed)</h2>
      <p>
        Swap <code>/gateway</code> for <code>/mock</code> to get a free,
        spec-generated example response — live, keyless, and <code>0</code>{" "}
        credits. Same URL shape, no <code>Authorization</code> header required:
      </p>
      <DocsCodeBlock
        lang="text"
        code={`${GATEWAY}/mock/{org}/{project}/{path}`}
      />
      <p>
        Responses carry <code>x-zevium-mock: 1</code>. Use it to exercise an
        API's shape before spending credits.
      </p>

      <h2>Response headers</h2>
      <p>
        Every gateway response carries metering headers so you can log cost and
        trace requests:
      </p>
      <DocsCodeBlock lang="http" code={RESPONSE_HEADERS} />
      <ul>
        <li>
          <code>x-zevium-request-id</code> — unique per call. Include it in
          support requests.
        </li>
        <li>
          <code>x-zevium-cost</code> — credits charged for this call (
          <code>0</code> on a free-tier call, which also sets{" "}
          <code>x-zevium-free-tier: 1</code>
          ).
        </li>
        <li>
          <code>Deprecation</code> / <code>Sunset</code> — present only when the
          API version is deprecated. Treat <code>Sunset</code> as a hard cutoff.
        </li>
      </ul>

      <h2>Zero balance blocks</h2>
      <p>
        If the wallet cannot cover the call, the gateway refuses it up front —
        HTTP <code>402</code>, no upstream request is made:
      </p>
      <DocsCodeBlock lang="json" code={INSUFFICIENT} />
      <p>
        Top up from <Link to="/app">Dashboard → Billing</Link> and retry. Never
        a surprise overage.
      </p>

      <h2>Refunds on upstream failure</h2>
      <p>
        Credits are reserved before the upstream call and settled on success. A
        non-2xx upstream response — or a gateway/timeout error (502) — refunds
        the reservation automatically. You pay only for successful responses.
      </p>
      <p>Other error codes you may hit:</p>
      <ul>
        <li>
          <code>401</code> — missing or invalid API key.
        </li>
        <li>
          <code>404</code> — unknown org/project or unmatched route.
        </li>
        <li>
          <code>429</code> — rate or quota exceeded.
        </li>
      </ul>
    </DocsPage>
  );
}
