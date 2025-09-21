import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { TRPCClientError } from "@trpc/client";
import { AutumnProvider } from "autumn-js/react";
import { Provider as JotaiProvider } from "jotai";
import { domAnimation, LazyMotion } from "motion/react";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import React, { useState } from "react";
import { toast } from "sonner";

import { ThemeProvider } from "~/components/theme-provider";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { clientEnv } from "~/env/client";
import { AutoCreateDefaultOrganization } from "~/hooks/use-ensure-default-organization";
import { BetterAuthException } from "~/lib/auth";
import { createClient, TRPCProvider } from "~/lib/trpc";

import { PostHogIdentify } from "./posthog-identify";
import { AppSidebar, PageHeader } from "./sidebar";
import { Toaster } from "./ui/sonner";

let _queryClientSingleton: null | QueryClient = null;

const makeQueryClient = () => {
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
    },
  });
};

const getQueryClient = () => {
  if (typeof window === "undefined") {
    return makeQueryClient();
  }
  if (_queryClientSingleton) {
    return _queryClientSingleton;
  }
  const queryClient = makeQueryClient();
  _queryClientSingleton = queryClient;
  return queryClient;
};

const PHProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  if (!clientEnv.VITE_PUBLIC_POSTHOG_KEY) {
    return <React.Fragment>{children}</React.Fragment>;
  }
  return (
    <PostHogProvider
      apiKey={clientEnv.VITE_PUBLIC_POSTHOG_KEY}
      options={{
        api_host: "/api/posthog",
        capture_exceptions: true,
        debug: import.meta.env.MODE === "development",
        defaults: "2025-05-24",
        ui_host: "https://us.posthog.com",
      }}
    >
      {children}
    </PostHogProvider>
  );
};

export const Providers: React.FC<React.PropsWithChildren> = ({ children }) => {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() => createClient());

  return (
    <PHProvider>
      <AutumnProvider betterAuthUrl={clientEnv.VITE_PUBLIC_URL}>
        <QueryClientProvider client={queryClient}>
          <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>
            <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
              <LazyMotion features={domAnimation} strict>
                <JotaiProvider>
                  <SidebarProvider>
                    <Toaster richColors />
                    <PostHogIdentify />
                    <AutoCreateDefaultOrganization />
                    <AppSidebar />
                    <SidebarInset>
                      <PageHeader />
                      {children}
                    </SidebarInset>
                  </SidebarProvider>
                </JotaiProvider>
              </LazyMotion>
            </ThemeProvider>
            <ReactQueryDevtools />
          </TRPCProvider>
        </QueryClientProvider>
      </AutumnProvider>
    </PHProvider>
  );
};
