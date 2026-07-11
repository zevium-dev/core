import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start";
import { auth } from "@clerk/tanstack-react-start/server";
import { shadcn } from "@clerk/ui/themes";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { ThemeProvider } from "#/components/theme-provider";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { convexQueryClient, type RouterContext } from "#/router";

import appCss from "../styles.css?url";
import clerkShadcnCss from "@clerk/ui/themes/shadcn.css?url";

/**
 * SSR: pull Clerk session + Convex JWT template so authed loaders
 * can hit Convex via serverHttpClient with identity.
 */
const fetchConvexAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ userId: string | null; token: string | null }> => {
    const session = await auth();
    const userId = session.userId ?? null;
    if (!userId) {
      return { userId: null, token: null };
    }
    const token = (await session.getToken({ template: "convex" })) ?? null;
    return { userId, token };
  },
);

const themeInitScript = `(function(){try{var k='zevium-theme';var t=localStorage.getItem(k);var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var dark=t==='dark'||(t!=='light'&&d);var r=document.documentElement;r.classList.toggle('dark',dark);r.style.colorScheme=dark?'dark':'light';}catch(e){}})();`;

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    const { userId, token } = await fetchConvexAuth();

    // SSR only: forward JWT into Convex HTTP client used by loaders.
    // Browser auth stays on ConvexProviderWithClerk.
    if (typeof window === "undefined") {
      if (token) {
        convexQueryClient.serverHttpClient?.setAuth(token);
      } else {
        convexQueryClient.serverHttpClient?.clearAuth();
      }
    }

    return { userId, token };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "Zevium" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "stylesheet", href: clerkShadcnCss },
    ],
    scripts: [{ children: themeInitScript }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <ClerkProvider appearance={{ theme: shadcn }}>
      <ConvexProviderWithClerk
        client={convexQueryClient.convexClient}
        useAuth={useAuth}
      >
        <ThemeProvider>
          <TooltipProvider>
            <Outlet />
            <Toaster />
            {import.meta.env.DEV ? (
              <TanStackDevtools
                config={{ position: "bottom-right" }}
                plugins={[
                  {
                    name: "Tanstack Router",
                    render: <TanStackRouterDevtoolsPanel />,
                  },
                ]}
              />
            ) : null}
          </TooltipProvider>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
