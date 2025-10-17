import { QueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import posthog from "posthog-js";
import { toast } from "sonner";

import { BetterAuthException } from "~/lib/auth";

export const makeQueryClient = () => {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        onError: (cause) => {
          if (cause instanceof TRPCClientError) {
            const error = new Error("[TRPC]: some error occurred", { cause });
            toast.error(cause.message);
            posthog.captureException(error);
          } else if (BetterAuthException.match(cause)) {
            console.log(cause.meta);
            if (cause.meta?.response.status === 429) {
              const retryAfter = cause.meta.response.headers.get("X-Retry-After");
              toast.error(`Too many requests. Please try again after ${retryAfter} seconds.`);
              posthog.captureException(cause);
            } else if (cause.message.includes("Email not verified")) {
              window.location.pathname = "/auth/sent-email";
            } else {
              const error = new Error("[BETTER_AUTH]: some error occurred", { cause });
              toast.error(cause.message || "Something went wrong");
              posthog.captureException(error);
            }
          } else {
            const error = new Error("some error occurred", { cause });
            toast.error(cause instanceof Error ? cause.message : "Something went wrong");
            posthog.captureException(error);
          }
          console.error(cause);
        },
      },
      queries: {
        networkMode: "offlineFirst",
        retry: 2,
        staleTime: 1000 * 60,
      },
    },
  });
};
