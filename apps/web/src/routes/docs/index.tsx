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

const FIRST_CALL = `ZEVIUM_API_KEY="paste-your-key-here"
curl "${GATEWAY}/gateway/acme/summarize/v1/summarize" \\
  --oauth2-bearer "$ZEVIUM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Zevium is an agent-first API marketplace."}'`;

function DocsIndexPage() {
  return (
    <DocsPage
      title="Getting started"
      description="Find an API, add credits to your organization’s wallet, and make your first live call."
    >
      <h2>What is Zevium</h2>
      <p>
        Zevium is an API marketplace for developers and agents. Publishers list
        APIs with an OpenAPI spec that describes each endpoint and its price.
        You can try free mock responses before paying for live calls.
      </p>
      <p>
        Your Zevium key works across the catalogue. Live calls use your
        organization’s prepaid wallet and stop when it has no balance.
      </p>

      <h2>Credits model</h2>
      <p>
        Each endpoint has a price in credits. Credits have the same dollar value
        across the catalogue:
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
        Add credits with a one-time top-up. Each successful paid call spends
        credits from your organization’s wallet, with 95% of the charge going to
        the publisher.
      </p>

      <h2>Quickstart</h2>
      <p>
        Choose an API from the catalogue, then follow these steps for a live
        call.
      </p>
      <ol>
        <li>
          <strong>Sign up.</strong> Create an account, then choose or create an
          organization. Its wallet funds your live API calls.
        </li>
        <li>
          <strong>Top up.</strong> Buy credits from{" "}
          <Link to="/app/billing">Billing</Link>. $1 buys 10,000 credits.
        </li>
        <li>
          <strong>Create a key.</strong> From{" "}
          <Link to="/app/settings/keys">Settings → Keys</Link>. Keys are linked
          to the selected organization’s wallet, with one current key per
          member. The secret is shown once; save it before closing the dialog.
        </li>
        <li>
          <strong>Make your first call.</strong> Copy the gateway URL from your
          chosen API’s <Link to="/catalogue">catalogue</Link> page. The example
          below uses placeholder API names and a sample body; replace them with
          the endpoint you chose:
        </li>
      </ol>
      <DocsCodeBlock lang="bash" code={FIRST_CALL} />
      <p>
        The gateway checks your key and reserves the call’s cost before
        contacting the publisher. A successful response settles the charge. A
        failed upstream response releases the reservation.
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
