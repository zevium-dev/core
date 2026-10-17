import { llmsResponse as sharedLlmsResponse } from "@zevium/shared";

import { resolveGatewayOrigin } from "./landing";

export function llmsResponse(request: Request, gatewayEnv?: string): Response {
  return sharedLlmsResponse({
    web: new URL(request.url).origin,
    gateway: resolveGatewayOrigin(gatewayEnv),
  });
}
