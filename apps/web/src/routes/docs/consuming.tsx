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
  "error": "payment_required",
  "detail": "Insufficient credits",
  "actions": {
    "createKey": "https://zevium.dev/app/settings/keys",
    "topUp": "https://zevium.dev/app/billing",
    "docs": "https://zevium.dev/docs/consuming"
  },
  "reason": "insufficient_credits",
  "requestId": "7f3c1a2b-9d4e-4a6c-8b1f-0e5d2a7c3f9b",
  "available": 3,
  "cost": 10
}`;

function DocsConsumingPage() {
  return (
    <DocsPage
      title="Consuming"
      description="Use your Zevium key to call catalogue APIs. Successful calls spend prepaid credits from your organization’s wallet."
    >
      <h2>API keys</h2>
      <p>
        Keys belong to an <strong>organization</strong>. Each member’s key
        spends from the shared wallet, and usage is attributed to that member.
        Create one from <Link to="/app/settings/keys">Settings → Keys</Link>:
      </p>
      <ul>
        <li>
          Each member can create one current key per organization. Organization
          admins manage rotation and revocation.
        </li>
        <li>
          The secret (prefix <code>ak_</code>) is shown <strong>once</strong> at
          creation. Store it immediately.
        </li>
        <li>
          Organization admins can set a monthly spending limit for each key.
          Rotation keeps the previous key working for 24 hours so you can update
          your applications. Revocation and limit changes can take up to one
          minute to reach the gateway.
        </li>
      </ul>

      <h2>Calling through the gateway</h2>
      <p>The gateway URL shape is fixed:</p>
      <DocsCodeBlock
        lang="text"
        code={`${GATEWAY}/gateway/{org}/{project}/{path}

org     — public publisher handle (from the catalogue URL)
project — API / project slug
path    — endpoint path from the spec (e.g. /v1/summarize)`}
      />
      <p>
        Authenticate with the key in the <code>Authorization</code> header
        (Bearer) or <code>x-api-key</code>. Query string and body pass through
        to the publisher’s API unchanged. Replace the example API names and body
        with those from your chosen endpoint:
      </p>
      <DocsCodeBlock lang="bash" code={CALL_EXAMPLE} />

      <h2>Mock calls (no key needed)</h2>
      <p>
        Swap <code>/gateway</code> for <code>/mock</code> to get a free example
        response generated from the published spec. It requires no key and costs{" "}
        <code>0</code> credits. Same URL shape, no <code>Authorization</code>{" "}
        header required:
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
        Gateway responses include a request ID. Responses forwarded from the
        publisher also include the endpoint cost:
      </p>
      <DocsCodeBlock lang="http" code={RESPONSE_HEADERS} />
      <ul>
        <li>
          <code>x-zevium-request-id</code> — unique per call. Include it in
          support requests.
        </li>
        <li>
          <code>x-zevium-cost</code> — endpoint cost in credits (<code>0</code>{" "}
          on a free-tier call, which also sets{" "}
          <code>x-zevium-free-tier: 1</code>
          ).
        </li>
        <li>
          <code>Deprecation</code> / <code>Sunset</code> — signal a migration
          notice or scheduled project retirement. Treat <code>Sunset</code> as a
          hard cutoff.
        </li>
      </ul>

      <h2>Zero balance blocks</h2>
      <p>
        If the wallet cannot cover the call, the gateway refuses it up front —
        HTTP <code>402</code>, no upstream request is made:
      </p>
      <DocsCodeBlock lang="json" code={INSUFFICIENT} />
      <p>
        Top up from <Link to="/app/billing">Billing</Link> and retry. A funded
        wallet is required even for live endpoints priced at zero credits.
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
          <code>402</code> — missing or invalid API key, or insufficient
          credits. Read <code>detail</code> and <code>reason</code> to choose a
          recovery action.
        </li>
        <li>
          <code>404</code> — API not found or no endpoint matches the method and
          path.
        </li>
        <li>
          <code>403</code> — key disabled, organization archived, or monthly key
          spending limit reached.
        </li>
      </ul>
    </DocsPage>
  );
}
