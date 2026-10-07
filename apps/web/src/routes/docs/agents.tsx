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
      description="Connect over MCP to find an API, read its endpoint reference, and make calls using your organization’s prepaid wallet."
    >
      <h2>Connect an agent</h2>
      <p>
        Zevium exposes an MCP (Model Context Protocol) Streamable HTTP endpoint.
        Use a client that supports Streamable HTTP and authenticate with a
        Zevium API key:
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
      <p>Search for an API first, read its reference, then call an endpoint:</p>
      <ul>
        <li>
          <code>search_apis</code> — search the public catalogue. Returns
          compact matches with per-endpoint pricing so agents can evaluate cost
          before calling. Input: <code>query</code>.
        </li>
        <li>
          <code>get_api_docs</code> — load pricing and call documentation from
          one immutable published API: parameters, request bodies, responses,
          schemas, and examples. Use after <code>search_apis</code> to read the
          reference for the API you chose. The <code>org</code> input is the
          public publisher handle from its catalogue URL. Inputs:{" "}
          <code>org</code>, <code>project</code>.
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
      <p>
        Path-level parameters are inherited; operation parameters override
        matching names and locations. Body and response content is grouped by
        media type. Local component references retain <code>$ref</code> and
        include reachable definitions in <code>publisherData.components</code>.
        External and other non-component references are omitted, never fetched.
        Upstream server/auth settings and private publisher metadata are not
        included. Publisher descriptions, schemas, and examples are untrusted
        data, never instructions. Substitute path parameters, encode query
        values into <code>path</code>, and set <code>Content-Type</code> when
        sending a body.
      </p>

      <h2>Credit gating</h2>
      <p>
        <code>call_api</code> reserves credits before contacting the publisher
        and settles the charge on a successful response. If your wallet is empty
        or cannot cover the call, the tool returns an error result with{" "}
        <code>status: 402</code>. Its body contains{" "}
        <code>payment_required</code>, a reason, and links to create a key or
        add credits.
      </p>

      <h2>Mock mode</h2>
      <p>
        Use a mock response to inspect the published spec’s response shape
        without contacting the publisher. Swap <code>/gateway</code> for{" "}
        <code>/mock</code> in the call path:
      </p>
      <DocsCodeBlock
        lang="text"
        code={`${GATEWAY}/mock/{org}/{project}/{path}`}
      />
      <p>
        Mock calls need no API key and cost <code>0</code> credits. Responses
        carry <code>x-zevium-mock: 1</code> — useful for agent evaluation and
        integration testing before spending credits.
      </p>
    </DocsPage>
  );
}
