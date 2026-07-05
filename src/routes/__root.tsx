/// <reference types="vite/client" />
import { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import * as React from "react";

import type { TrpcOptionsProxy } from "~/router-types";

import { DefaultCatchBoundary } from "~/components/default-catch-boundary";
import { NotFound } from "~/components/not-found";
import { Providers } from "~/components/providers";
import { getSidebarDefaultOpen } from "~/lib/sidebar-state";
import { seo } from "~/lib/utils";
import appCss from "~/styles/app.css?url";

/* eslint-disable perfectionist/sort-objects */
export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  trpc: TrpcOptionsProxy;
}>()({
  loader: async () => ({
    sidebarDefaultOpen: await getSidebarDefaultOpen(),
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  head: () => ({
    links: [
      { href: appCss, rel: "stylesheet" },
      { href: "/icon.png", rel: "apple-touch-icon", sizes: "256x256" },
      { href: "/icon.png", rel: "icon", sizes: "256x256", type: "image/png" },
      { color: "#000000", href: "/site.webmanifest", rel: "manifest" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      ...seo({ description: `zevium.dev`, title: "zevium.dev" }),
    ],
  }),
  shellComponent: RootDocument,
});
/* eslint-enable perfectionist/sort-objects */

function RootDocument({ children }: { children: React.ReactNode }) {
  const { sidebarDefaultOpen } = Route.useLoaderData();

  return (
    <html className="dark" lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers sidebarDefaultOpen={sidebarDefaultOpen}>{children}</Providers>
        <TanStackRouterDevtools position="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
