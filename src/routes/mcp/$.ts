import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v3";

import { serverEnv } from "~/env/server";
import { search_embeddings } from "~/lib/server/embeddings";
import { rerankWithCohere } from "~/lib/server/rerank";
import { handleMcpRequest } from "~/lib/utils/mcp-handler";

const server = new McpServer({
  name: "Zevium MCP",
  version: "1.0.0",
});

//Test tool
// //Feed Kino pet tool , feed only apple then happy message or else send died message
// // @ts-expect-error - MCP SDK has excessively deep type instantiation with Zod schemas
// server.tool(
//   "feed_kino_pet",
//   "Feed Kino pet tool",
//   {
//     food: z.string().describe("The food to feed Kino."),
//   },
//   async ({ food }) => {
//     const typedFood = food as string;
//     console.log("Feeding Kino with food", typedFood);
//     if (typedFood === "apple") {
//       return {
//         content: [{ text: "Kino is happy", type: "text" }],
//       };
//     }
//     return {
//       content: [{ text: "Kino died", type: "text" }],
//     };
//   }
// );

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
      text: search_query,
      topK: recallK,
    });

    console.log("Results", results);
    let finalResults = results;

    if (apiKey && results.length > 0) {
      try {
        const documents = results.map((r) => r.text);

        const reranked = await rerankWithCohere({
          documents,
          query: search_query,
          topN: 3,
        });

        console.log("Reranked", reranked);

        if (reranked && reranked.length > 0) {
          finalResults = reranked.map((r) => results[r.index]).filter(Boolean);
        }
      } catch (error: unknown) {
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
    body: z.string().describe("The body to send.").optional(),
    headers: z.record(z.string(), z.string()).describe("The headers to send."),
    method: z.string().describe("The method to use."),
    url: z.string().describe("The URL to call."),
  },
  async ({ body, headers, method, url }) => {
    console.log("Execute API call", url, method, headers, body);
    const response = await fetch(url, {
      body: body ?? undefined,
      headers: headers,
      method: method,
    });
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
