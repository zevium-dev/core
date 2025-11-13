import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { Exception } from "@boi.gg/exception";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export class MCPSendException extends Exception.kind<{ originalError: Error }>("MCPSendException") {}
export class MCPTimeoutException extends Exception.kind<{ timeoutMs: number }>("MCPTimeoutException") {}
export class MCPTransportException extends Exception.kind<{ originalError: Error }>("MCPTransportException") {}

export async function handleMcpRequest(
  request: Request,
  server: McpServer,
  options?: { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  try {
    console.log("handleMCCP start");
    const jsonRpcRequest = (await request.json()) as JSONRPCMessage;

    console.log("jsonRpcRequest", jsonRpcRequest);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const responseData: Array<JSONRPCMessage> = [];

    await server.connect(serverTransport);

    await clientTransport.start();
    await serverTransport.start();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new MCPTimeoutException("MCP request timeout", { timeoutMs }) as Error);
      }, timeoutMs);

      clientTransport.onmessage = (message: JSONRPCMessage) => {
        responseData.push(message);
        clearTimeout(timeout);
        resolve();
      };

      clientTransport.onerror = (error: Error) => {
        clearTimeout(timeout);
        reject(new MCPTransportException("MCP transport error", { originalError: error }, error) as Error);
      };

      clientTransport.send(jsonRpcRequest).catch((error: unknown) => {
        clearTimeout(timeout);
        const err = error instanceof Error ? error : new Error(String(error));
        reject(new MCPSendException("Failed to send MCP request", { originalError: err }, err) as Error);
      });
      // @ts-expect-error - method may not exist on all request types
      if (jsonRpcRequest.method === "notifications/initialized") {
        clearTimeout(timeout);
        resolve();
      }
    });
    console.log("responseData", responseData);

    await clientTransport.close();
    await serverTransport.close();

    // Return the last message for backwards compatibility, but support multiple messages
    const result = responseData.length > 0 ? responseData[responseData.length - 1] : null;
    return Response.json(result, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("MCP handler error:", error);

    // Return a JSON-RPC error response
    return Response.json(
      {
        error: {
          code: -32603,
          data: error instanceof Error ? error.message : String(error),
          message: "Internal server error",
        },
        id: null,
        jsonrpc: "2.0",
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        status: 500,
      },
    );
  }
}
