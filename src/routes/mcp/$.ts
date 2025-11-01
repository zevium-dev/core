import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getRequest, getResponse } from '@tanstack/react-start/server'
import { createFileRoute } from "@tanstack/react-router";
import z from "zod/v3";
import { IncomingMessage } from "node:http";
import { getEventListeners } from "node:events";
import { handleMcpRequest } from "~/lib/utils/mcp-handler";
import { serverEnv } from "~/env/server";
import { client } from "~/db";

export const getEmbeddings = (async (data: { input: string, model: string }) => {
  const response = await fetch(
    "https://router.huggingface.co/nebius/v1/embeddings",
    {
      headers: {
        Authorization: `Bearer ${serverEnv.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify(data),
    }
  );
  const result = await response.json() as { data: { embedding: number[] }[] };
  return result.data[0].embedding;
});

export const search_embeddings = async (data: { text: string, modelName: string, topK: number }) => {
  console.log("Search embeddings start");
  const { text, modelName, topK = 3 } = data
  const embedding = await getEmbeddings({ input: text, model: modelName })
  console.log("Embedding", embedding);
  // Perform vector similarity search
  const sql = `SELECT pe.id, pe.text FROM vector_top_k('project_embeddings_idx', vector32(?), ?) AS v JOIN project_embeddings AS pe ON pe.rowid = v.id`;
  //         const sql = `
  // SELECT *
  // FROM vector_top_k('project_embeddings_idx', vector32(?), ?)
  // `;

  try {
    const result = await client.execute({
      sql,
      args: [JSON.stringify(embedding), topK],
    });
    return result.rows;
  } catch (error) {
    throw error;
  }
};


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

    // do a post call to the /api/embedding/search endpoint
    const response = await fetch("http://localhost:5173/api/embedding/search", {
      method: "POST",
      body: JSON.stringify({ text: search_query, modelName: "Qwen/Qwen3-Embedding-8B", topK: 3 }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const results = await response.json();
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
    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
