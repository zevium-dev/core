import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export async function handleMcpRequest(
  request: Request,
  server: McpServer,
): Promise<Response> {
  try {
    console.log('handleMCCP start');
    const jsonRpcRequest = (await request.json()) as JSONRPCMessage

    console.log('jsonRpcRequest', jsonRpcRequest)

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()

    let responseData: JSONRPCMessage | null = null; 


    await server.connect(serverTransport)

    await clientTransport.start()
    await serverTransport.start()

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MCP request timeout'));
      }, 10000) // 10 second timeout
    
      clientTransport.onmessage = (message: JSONRPCMessage) => {
       responseData = message;
       clearTimeout(timeout)
       resolve();
     }

     clientTransport.onerror = (error: Error) => {
       clearTimeout(timeout)
       reject(error)
     }

     clientTransport.send(jsonRpcRequest).catch((error) => {
       clearTimeout(timeout)
       reject(error)
     })
     // @ts-ignore
     if(jsonRpcRequest.method === 'notifications/initialized'){ 
      clearTimeout(timeout)
      resolve();
     }
   })
   console.log('responseData', responseData)

    await clientTransport.close()
    await serverTransport.close()
    

    return Response.json(responseData, {
      headers: {
        'Content-Type': 'application/json',
      },
    })
  } catch (error) {
    console.error('MCP handler error:', error)

    // Return a JSON-RPC error response
    return Response.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
          data: error instanceof Error ? error.message : String(error),
        },
        id: null,
      },
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }
}