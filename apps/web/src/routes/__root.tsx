import { auth } from "@clerk/tanstack-react-start/server";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  type ErrorComponentProps,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import { ConvexProvider } from "convex/react";
import { useEffect, useRef } from "react";

import { PublicHeader } from "#/components/public-header";
import { ThemeProvider } from "#/components/theme-provider";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "#/components/ui/empty";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { readClientClerkAuth } from "#/lib/clerk-client";
import { needsAuthenticatedProviders } from "#/lib/provider-scope";
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
const buildSha =
  import.meta.env.VITE_BUILD_SHA ?? (import.meta.env.DEV ? "development" : "");
if (!import.meta.env.DEV && !/^[0-9a-f]{40}$/.test(buildSha)) {
  throw new Error("Production build lacks a full VITE_BUILD_SHA");
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async (options): Promise<ConvexAuthSnapshot> => {
    const { context } = options;
    // Client nav: no server round-trip. Clerk browser state is sync.
    // token stays null — ConvexProviderWithClerk owns browser Convex auth.
    if (typeof window !== "undefined") {
      const client = readClientClerkAuth({
        userId: context.userId,
        orgId: context.orgId,
        orgSlug: context.orgSlug,
      });
      await context.principalCache.transition(client.userId, client.orgId);
      return {
        userId: client.userId,
        token: null,
        orgSlug: client.orgSlug,
        orgId: client.orgId,
      };
    }

    const serverContext = (
      options as typeof options & { serverContext?: { nonce?: string } }
    ).serverContext;
    if (serverContext?.nonce) context.applySsrNonce(serverContext.nonce);

    const { userId, token, orgSlug, orgId } = await fetchConvexAuth();
    await context.principalCache.transition(userId, orgId);

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
      { name: "zevium-build", content: buildSha },
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
  notFoundComponent: GlobalNotFound,
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

function GlobalNotFound() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <title>Page not found · Zevium</title>
      <PublicHeader />
      <main
        id="main-content"
        className="mx-auto max-w-3xl px-4 py-12"
        tabIndex={-1}
      >
        <Empty className="min-h-80 border border-dashed">
          <EmptyHeader>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-medium tracking-tight outline-none"
            >
              Page not found
            </h1>
            <EmptyDescription>
              This address does not match a Zevium page. Choose a safe route or
              return to your previous page.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center">
            <Button asChild>
              <Link to="/">Home</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/catalogue">Catalogue</Link>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.history.back()}
            >
              Back
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    </div>
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

  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const nonce = useRouter().options.ssr?.nonce;

  const content = (
    <ThemeProvider nonce={nonce}>
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
  );

  // App/admin/auth layouts own Clerk + Convex auth. Avoid nesting the same
  // Convex client under an anonymous provider, which can race token setup.
  if (needsAuthenticatedProviders(pathname)) return content;

  return (
    <ConvexProvider client={convexQueryClient.convexClient}>
      {content}
    </ConvexProvider>
  );
}
