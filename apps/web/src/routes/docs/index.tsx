import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsCodeBlock } from "#/components/docs-code-block";
import { DocsPage } from "#/components/docs-layout";
import { resolveGatewayOrigin } from "#/lib/landing";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Docs · Zevium" },
      {
        name: "description",
        content:
          "Get started with Zevium: the agent-first, per-call API marketplace.",
      },
    ],
  }),
  component: DocsIndexPage,
});

const GATEWAY = resolveGatewayOrigin(
  import.meta.env.VITE_GATEWAY_URL as string | undefined,
);

const FIRST_CALL = `curl "${GATEWAY}/gateway/acme/summarize/v1/summarize" \\
  -H "Authorization: Bearer ak_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Zevium is an agent-first API marketplace."}'`;

function DocsIndexPage() {
  return (
    <DocsPage
      title="Getting started"
      description="Zevium is an agent-first, per-call API marketplace. Publishers list APIs via OpenAPI specs; consumers prepay credits and pay per call through a metered gateway."
    >
      <h2>What is Zevium</h2>
      <p>
        Publishers publish APIs described by OpenAPI specs. Consumers — human
        developers and AI agents — pay per call via prepaid credits through a
        metered gateway. The spec is the product: upstream address, endpoints,
        per-endpoint pricing, and free tier all live in the spec.
      </p>
      <p>
        Every call flows through one gateway URL, authenticated by one key,
        metered against one org wallet. Zero balance blocks the call — never a
        surprise overage.
      </p>

      <h2>Credits model</h2>
      <p>
        Pricing is declared per endpoint in the spec as credits. One global
        exchange rate, never per-API:
      </p>
      <DocsCodeBlock
        lang="text"
        code={`$1 = 10,000 credits   (1 credit = $0.0001)

Per call:
  Consumer pays       100 credits
  Zevium takes          5 credits  (5% platform cut)
  Publisher earns      95 credits  (95% revenue share)`}
      />
      <p>
        Credits are prepaid by the consumer org via one-time top-ups. The
        platform cut and publisher share settle per call at charge time.
        Publisher earnings accumulate toward payouts.
      </p>

      <h2>Quickstart</h2>
      <p>
        From zero to first metered call in under a minute, fully self-serve.
      </p>
      <ol>
        <li>
          <strong>Sign up.</strong> Create an account. A personal org is created
          automatically — the org owns the wallet.
        </li>
        <li>
          <strong>Top up.</strong> Buy credits from{" "}
          <Link to="/app">Dashboard → Billing</Link>. $1 buys 10,000 credits.
        </li>
        <li>
          <strong>Create a key.</strong> From{" "}
          <Link to="/app/settings/keys">Settings → Keys</Link>. Keys are
          org-scoped — one per user, drawing from the org wallet. The secret is
          shown once; copy it now.
        </li>
        <li>
          <strong>Make your first call.</strong> Find an API in the{" "}
          <Link to="/catalogue">catalogue</Link>, then call its gateway URL:
        </li>
      </ol>
      <DocsCodeBlock lang="bash" code={FIRST_CALL} />
      <p>
        The gateway authenticates your key, checks the wallet covers the call,
        forwards to the publisher's upstream, and streams the response back. You
        pay only on a successful upstream response — failures refund
        automatically.
      </p>

      <h2>Next</h2>
      <ul>
        <li>
          <Link to="/docs/consuming">Consumer guide</Link> — keys, gateway URLs,
          response headers, refunds.
        </li>
        <li>
          <Link to="/docs/publishing">Publisher guide</Link> — spec, pricing,
          publish, webhooks.
        </li>
        <li>
          <Link to="/docs/agents">Agent guide</Link> — MCP endpoint, discovery
          index, tools.
        </li>
      </ul>
    </DocsPage>
  );
}
