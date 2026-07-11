import { createFileRoute } from "@tanstack/react-router";

import { DocsCodeBlock } from "#/components/docs-code-block";
import { DocsPage } from "#/components/docs-layout";
import {
  buildMcpConfigSnippet,
  discoveryEndpointUrl,
  mcpEndpointUrl,
  resolveGatewayOrigin,
} from "#/lib/landing";

export const Route = createFileRoute("/docs/agents")({
  head: () => ({
    meta: [
      { title: "Agents · Zevium Docs" },
      {
        name: "description",
        content:
          "Consume Zevium APIs as agent tools: MCP endpoint, discovery index, tool list.",
      },
    ],
  }),
  component: DocsAgentsPage,
});

const GATEWAY = resolveGatewayOrigin(
  import.meta.env.VITE_GATEWAY_URL as string | undefined,
);
const MCP_URL = mcpEndpointUrl(GATEWAY);
const DISCOVERY_URL = discoveryEndpointUrl(GATEWAY);
const MCP_CONFIG = buildMcpConfigSnippet(MCP_URL);

function DocsAgentsPage() {
  return (
    <DocsPage
      title="Agents"
      description="Every published API is consumable as agent tools through the same metered, credit-gated gateway as human traffic. No unmetered side doors."
    >
      <h2>Connect an agent</h2>
      <p>
        Zevium exposes an MCP (Model Context Protocol) Streamable HTTP endpoint.
        Point any MCP-compatible client at it and authenticate with a Zevium API
        key:
      </p>
      <DocsCodeBlock lang="json" code={MCP_CONFIG} />
      <p>
        The <code>url</code> above resolves from the gateway origin. Replace{" "}
        <code>YOUR_API_KEY</code> with a key (prefix <code>ak_</code>) from{" "}
        Settings → Keys.
      </p>

      <h2>Discovery index</h2>
      <p>
        A machine-readable catalogue of published APIs with per-endpoint pricing
        metadata, so agents can evaluate cost <strong>before</strong> calling.
        Crawl it directly:
      </p>
      <DocsCodeBlock lang="bash" code={`curl "${DISCOVERY_URL}"`} />

      <h2>Tools</h2>
      <p>Three tools — search-then-load, never a dump of every endpoint:</p>
      <ul>
        <li>
          <code>search_apis</code> — search the public catalogue. Returns
          compact matches with per-endpoint pricing so agents can evaluate cost
          before calling. Input: <code>query</code>.
        </li>
        <li>
          <code>get_api_docs</code> — load the endpoint list, pricing, and usage
          notes for one published API. Use after <code>search_apis</code> to
          load only the tools you need. Inputs: <code>org</code>,{" "}
          <code>project</code>.
        </li>
        <li>
          <code>call_api</code> — execute a metered API call through the
          gateway. Requires a consumer key (Authorization on the MCP request, or
          a <code>key</code> argument). Credits reserve and settle like any
          gateway call. Inputs: <code>org</code>, <code>project</code>,{" "}
          <code>method</code>, <code>path</code>, optional <code>body</code>,{" "}
          <code>headers</code>, <code>key</code>.
        </li>
      </ul>

      <h2>Credit gating</h2>
      <p>
        <code>call_api</code> routes through the same credit gate as human
        traffic. Zero balance blocks the call — the gateway returns{" "}
        <code>402 insufficient_credits</code> with the wallet's current balance
        and the call's cost. No unmetered paths exist.
      </p>

      <h2>Mock mode</h2>
      <p>
        Free, spec-generated mock responses are coming. You will be able to
        exercise an API's shape through the gateway without spending credits —
        useful for agent evaluation and integration testing.
      </p>
    </DocsPage>
  );
}
