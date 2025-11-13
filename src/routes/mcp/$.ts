import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFileRoute } from "@tanstack/react-router";
import { getRequest, getResponse } from "@tanstack/react-start/server";
import { getEventListeners } from "node:events";
import { IncomingMessage } from "node:http";
import z from "zod/v3";

import { serverEnv } from "~/env/server";
import { search_embeddings } from "~/lib/server/embeddings";
import { handleMcpRequest } from "~/lib/utils/mcp-handler";

const server = new McpServer({
  capabilities: {
    resources: {},
    tools: {},
  },
  name: "Zevium MCP",
  version: "1.0.0",
});

server.tool(
  "search_zevium_api",
  "This tool is used for searching the APIs available in the Zevium platform. It will do a similarity search on the API name and description and return the most relevant APIs.",
  {
    search_query: z.string().describe("The query to search for APIs."),
  },
  async ({ search_query }) => {
    //return a list of food items
    console.log("Search query", search_query);

    // use the search_embeddings function to get the results
    const results = await search_embeddings({ modelName: "Qwen/Qwen3-Embedding-8B", text: search_query, topK: 3 });
    console.log(JSON.stringify(results));
    return {
      content: [
        {
          text: JSON.stringify(results),
          type: "text",
        },
      ],
    };
  },
);

//Tool to execute an API call using the Zevium. It will take url , method, headers, body and return the response.
server.tool(
  "execute_api_call",
  "Execute an API call using the Zevium. It will take url , method, headers, body and return the response.",
  {
    body: z.string().optional().describe("The body to send."),
    headers: z.record(z.string(), z.string()).describe("The headers to send."),
    method: z.string().describe("The method to use."),
    url: z.string().describe("The URL to call."),
  },
  async ({ body, headers, method, url }) => {
    console.log("Execute API call", url, method, headers, body);
    const response = await fetch(url, { body: body ? body : undefined, headers, method });
    return {
      content: [
        {
          text: await response.text(),
          type: "text",
        },
      ],
    };
  },
);

export const Route = createFileRoute("/mcp/$")({
  server: {
    handlers: {
      POST: async ({ request }) => handleMcpRequest(request, server),
    },
  },
});
