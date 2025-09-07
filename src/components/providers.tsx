import { Provider as JotaiProvider } from "jotai";
import { domAnimation, LazyMotion } from "motion/react";
import { PostHogProvider } from "posthog-js/react";
import React from "react";

import { ThemeProvider } from "~/components/theme-provider";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { clientEnv } from "~/env/client";

// import { PostHogIdentify } from "./posthog-identify";
// import { AppSidebar, PageHeader } from "./sidebar";
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
        defaults: "2025-05-24",
        ui_host: "https://us.posthog.com",
      }}
    >
      {children}
    </PostHogProvider>
  );
};

export const Providers: React.FC<React.PropsWithChildren> = ({ children }) => {
  return (
    <PHProvider>
      <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
        <LazyMotion features={domAnimation} strict>
          <JotaiProvider>
            <SidebarProvider>
              <Toaster />
              {/* <PostHogIdentify /> */}
              {/* <AppSidebar /> */}
              <SidebarInset>
                {/* <PageHeader /> */}
                {children}
              </SidebarInset>
            </SidebarProvider>
          </JotaiProvider>
        </LazyMotion>
      </ThemeProvider>
    </PHProvider>
  );
};
