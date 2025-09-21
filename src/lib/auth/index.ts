import { Exception } from "@boi.gg/exception";
import { apiKeyClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient, ErrorContext } from "better-auth/react";

export class BetterAuthException extends Exception.kind<ErrorContext>("BetterAuthException") {}

export const auth = createAuthClient({
  fetchOptions: {
    onError: (ctx) => {
      throw new BetterAuthException(ctx.error.message, ctx, ctx.error);
    },
  },
  plugins: [apiKeyClient(), organizationClient()],
});
