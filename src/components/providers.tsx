import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { TRPCClientError } from "@trpc/client";
import { Provider as JotaiProvider } from "jotai";
import { domAnimation, LazyMotion } from "motion/react";
import { PostHogProvider } from "posthog-js/react";
import React, { useState } from "react";
import { toast } from "sonner";

import { ThemeProvider } from "~/components/theme-provider";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { clientEnv } from "~/env/client";
import { AutoCreateDefaultOrganization } from "~/hooks/use-ensure-default-organization";
import { createClient, TRPCProvider } from "~/lib/trpc";

import { PostHogIdentify } from "./posthog-identify";
import { AppSidebar, PageHeader } from "./sidebar";
import { Toaster } from "./ui/sonner";

let _queryClientSingleton: null | QueryClient = null;

const makeQueryClient = () => {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        onError: (error) => {
          if (error instanceof TRPCClientError) {
            toast.error(error.message);
          } else {
            toast.error("Something went wrong");
          }
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
      <QueryClientProvider client={queryClient}>
        <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>
          <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
            <LazyMotion features={domAnimation} strict>
              <JotaiProvider>
                <SidebarProvider>
                  <Toaster />
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
    </PHProvider>
  );
};
