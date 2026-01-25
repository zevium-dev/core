import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useLocation } from "@tanstack/react-router";
import { Provider as JotaiProvider } from "jotai";
import { domAnimation, LazyMotion } from "motion/react";
import { PostHogErrorBoundary, PostHogProvider } from "posthog-js/react";
import React from "react";

import { ConfirmProvider } from "~/components/confirm-dialog";
import { ThemeProvider } from "~/components/theme-provider";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { clientEnv } from "~/env/client";
import { getQueryClient } from "~/lib/query-client";
import { TRPCProvider } from "~/lib/trpc";
import { getTrpcClient } from "~/lib/trpc/trpc";

import { PostHogIdentify } from "./posthog-identify";
import { MainSidebar, PageHeader } from "./sidebar";
import { Toaster } from "./ui/sonner";

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
        defaults: "2025-11-30",
        person_profiles: "identified_only",
        ui_host: "https://us.posthog.com",
      }}
    >
      {children}
    </PostHogProvider>
  );
};

export const Providers: React.FC<React.PropsWithChildren> = ({ children }) => {
  const queryClient = getQueryClient();
  const trpcClient = getTrpcClient();
  const location = useLocation();
  const isAppRoute = location.pathname.startsWith("/app");

  return (
    <PHProvider>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>
          <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
            <LazyMotion features={domAnimation} strict>
              <JotaiProvider>
                <ConfirmProvider>
                  <Toaster richColors />
                  <PostHogIdentify />
                  {!isAppRoute && (
                    <SidebarProvider>
                      <MainSidebar />
                      <SidebarInset>
                        <PageHeader />
                        {children}
                      </SidebarInset>
                    </SidebarProvider>
                  )}
                  {isAppRoute && children}
                </ConfirmProvider>
              </JotaiProvider>
            </LazyMotion>
          </ThemeProvider>
          <ReactQueryDevtools />
        </TRPCProvider>
      </QueryClientProvider>
    </PHProvider>
  );
};
