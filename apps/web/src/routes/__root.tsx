import { ClerkProvider, useAuth } from "@clerk/tanstack-react-start";
import { auth } from "@clerk/tanstack-react-start/server";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
  HeadContent,
  Outlet,
  Scripts,
  type ErrorComponentProps,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { ThemeProvider } from "#/components/theme-provider";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { Button } from "#/components/ui/button";
import { readClientClerkAuth } from "#/lib/clerk-client";
import { clerkShadcnTheme } from "#/lib/clerk-theme";
import type { RouterContext } from "#/router";

import appCss from "../styles.css?url";

type ConvexAuthSnapshot = {
  userId: string | null;
  token: string | null;
  orgSlug: string | null;
  orgId: string | null;
};

/**
 * SSR: pull Clerk session + Convex JWT template so authed loaders
 * can hit Convex via serverHttpClient with identity.
 */
const fetchConvexAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConvexAuthSnapshot> => {
    const session = await auth();
    const userId = session.userId ?? null;
    if (!userId) {
      return { userId: null, token: null, orgSlug: null, orgId: null };
    }
    const token = (await session.getToken({ template: "convex" })) ?? null;
    return {
      userId,
      token,
      orgSlug: session.orgSlug ?? null,
      orgId: session.orgId ?? null,
    };
  },
);

const themeInitScript = `(function(){try{var k='zevium-theme';var t=localStorage.getItem(k);var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var dark=t==='dark'||(t!=='light'&&d);var r=document.documentElement;r.classList.toggle('dark',dark);r.style.colorScheme=dark?'dark':'light';}catch(e){}})();`;

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }): Promise<ConvexAuthSnapshot> => {
    // Client nav: no server round-trip. Clerk browser state is sync.
    // token stays null — ConvexProviderWithClerk owns browser Convex auth.
    if (typeof window !== "undefined") {
      const client = readClientClerkAuth({
        userId: context.userId,
        orgId: context.orgId,
        orgSlug: context.orgSlug,
      });
      return {
        userId: client.userId,
        token: null,
        orgSlug: client.orgSlug,
        orgId: client.orgId,
      };
    }

    const { userId, token, orgSlug, orgId } = await fetchConvexAuth();

    // SSR only: forward JWT into Convex HTTP client used by loaders.
    // Browser auth stays on ConvexProviderWithClerk.
    if (token) {
      context.convexQueryClient.serverHttpClient?.setAuth(token);
    } else {
      context.convexQueryClient.serverHttpClient?.clearAuth();
    }

    return { userId, token, orgSlug, orgId };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "Zevium" },
      {
        name: "zevium-release",
        content:
          (import.meta.env.VITE_RELEASE_SHA as string | undefined) ??
          "development",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/logo.svg", type: "image/svg+xml" },
      { rel: "manifest", href: "/manifest.json" },
    ],
    scripts: [{ children: themeInitScript }],
  }),
  component: RootComponent,
  errorComponent: RootError,
  shellComponent: RootDocument,
});

function RootError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Page failed to load</h1>
      <p className="text-sm text-muted-foreground">
        {error instanceof Error
          ? error.message
          : "Unexpected application error"}
      </p>
      <Button className="self-start" onClick={reset}>
        Retry
      </Button>
    </main>
  );
}

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
  const { convexQueryClient } = Route.useRouteContext();

  return (
    <ClerkProvider appearance={{ theme: clerkShadcnTheme }}>
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
