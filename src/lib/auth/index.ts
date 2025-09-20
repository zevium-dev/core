import { apiKeyClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import posthog from "posthog-js";
import { toast } from "sonner";

export const auth = createAuthClient({
  fetchOptions: {
    onError: (ctx) => {
      if (ctx.response.status === 429) {
        const retryAfter = ctx.response.headers.get("X-Retry-After");
        toast.error(`Too many requests. Please try again after ${retryAfter} seconds.`);
      } else {
        const error = new Error("[BETTER_AUTH]: some error occurred", { cause: ctx.error });
        posthog.captureException(error);
        console.error(ctx.response);
        toast.error("Something went wrong");
      }
    },
  },
  plugins: [apiKeyClient(), organizationClient()],
});
