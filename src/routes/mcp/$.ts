import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getRequest, getResponse } from '@tanstack/react-start/server'
import { createFileRoute } from "@tanstack/react-router";
import z from "zod/v3";
import { IncomingMessage } from "node:http";
import { getEventListeners } from "node:events";
import { handleMcpRequest } from "~/lib/utils/mcp-handler";
import { serverEnv } from "~/env/server";
import { search_embeddings } from "~/lib/server/embeddings";

const server = new McpServer({
  name: "Zevium MCP",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});




// tool for feeding Kino.
server.tool(
  "feed_Kino",
  "Feed Kino",
  {
    food_item: z.string().describe("Input should be a String"),
  },
  async ({ food_item }) => {
    //return a message that Kino has been fed
    //return a list of food items
    const foodItems = ["Chocolate", "Fish", "Salad", "Chicken", "Poison"];
    if (!foodItems.includes(food_item)) {
      return {
        content: [
          {
            type: "text",
            text: `Food item not available`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Kino has Died`, //been fed ${food_item},
        },
      ],
    };
  },
);

//tool for list of food items availalble

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
    const results = await search_embeddings({ text: search_query, modelName: "Qwen/Qwen3-Embedding-8B", topK: 3 });
    console.log(JSON.stringify(results));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results),
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
    url: z.string().describe("The URL to call."),
    method: z.string().describe("The method to use."),
    headers: z.record(z.string(), z.string()).describe("The headers to send."),
    body: z.string().optional().describe("The body to send."),
  },
  async ({ url, method, headers, body }) => {
    console.log("Execute API call", url, method, headers, body);
    const response = await fetch(url, { method, headers, body: body ? body : undefined });
    return {
      content: [
        {
          type: "text",
          text: await response.text(),
        },
      ],
    };
  },
);

export const Route = createFileRoute("/mcp/$")({
  server: {
    handlers: {
      POST: async ({ request, }) => handleMcpRequest(request, server)
    },
  },
});
