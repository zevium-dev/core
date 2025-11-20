import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFileRoute } from "@tanstack/react-router";
import { getRequest, getResponse } from "@tanstack/react-start/server";
import { getEventListeners } from "node:events";
import { IncomingMessage } from "node:http";
import z from "zod/v3";

import { serverEnv } from "~/env/server";
import { search_embeddings } from "~/lib/server/embeddings";
import { rerankWithCohere } from "~/lib/server/rerank";
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

    const apiKey = serverEnv.COHERE_API_KEY;
    const recallK = apiKey ? 6 : 3;

    // use the search_embeddings function to get the results
    const results = await search_embeddings({
      modelName: "Qwen/Qwen3-Embedding-8B",
      text: search_query,
      topK: recallK,
    });

    let finalResults = results;

    if (apiKey && results.length > 0) {
      try {
        const documents = results.map((r: any) => r.text);

        const reranked = await rerankWithCohere({
          query: search_query,
          documents,
          topN: 3,
        });

        console.log("Reranked", reranked);

        if (reranked && reranked.length > 0) {
          finalResults = reranked.map((r) => results[r.index]).filter(Boolean);
        }
      } catch (error) {
        console.error("Cohere rerank failed, falling back to vector search:", error);
      
      }
    }

    const slicedResults = finalResults.slice(0, 3);

    console.log(JSON.stringify(slicedResults));
    return {
      content: [
        {
          text: JSON.stringify(slicedResults),
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
