import {
  useAuth,
  useOrganization,
  useOrganizationList,
} from "@clerk/tanstack-react-start";
import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { AppHeader } from "#/components/app-header";
import { AppSidebar } from "#/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
import { useEnsureMirror } from "#/hooks/use-ensure-mirror";
import { safeAppReturnPath } from "#/lib/auth-redirect";
import { readClientClerkAuth } from "#/lib/clerk-client";
import { requireAuth } from "#/lib/auth-session";
import type { RouterContext } from "#/router";

export const Route = createFileRoute("/app")({
  beforeLoad: async ({ context, location }) => {
    const signInRedirect = () =>
      redirect({
        to: "/sign-in/$",
        search: { redirect_url: safeAppReturnPath(location.href) },
      });

    // Client: gate from live Clerk / cached context — no server fn.
    if (typeof window !== "undefined") {
      const { userId } = readClientClerkAuth({
        userId: (context as RouterContext).userId,
      });
      if (!userId) {
        throw signInRedirect();
      }
      return;
    }

    // SSR: full server auth check.
    try {
      await requireAuth();
    } catch (err) {
      // requireAuth throws redirect; rethrow known redirects, else force sign-in
      if (err && typeof err === "object" && "to" in err) {
        throw signInRedirect();
      }
      throw signInRedirect();
    }
  },
  component: AppLayout,
});

function AppLayout() {
  useEnsureMirror();
  useOrgLessGuard();

  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only fixed top-4 left-4 rounded-md bg-background px-3 py-2 text-sm font-medium shadow-md focus:not-sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        Skip to main content
      </a>
      <AppSidebar />
      <SidebarInset className="md:peer-data-[state=collapsed]:ml-0!">
        <AppHeader />
        <div
          id="main-content"
          tabIndex={-1}
          className="flex flex-1 flex-col gap-4 p-4 focus-visible:outline-none md:p-6 content-enter"
          style={{ viewTransitionName: "main-content" }}
        >
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Belt-and-braces guard for pre-existing org-less users. Clerk
 * auto-org-creation is now enabled instance-wide for new signups, but users
 * created before that flip can still land with no active org and zero
 * memberships. When that happens, push them to /app/org/create.
 *
 * Guards against a redirect loop by skipping entirely under /app/org — that
 * subtree (including the create screen itself) must always render.
 */
function useOrgLessGuard() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: orgLoaded, organization } = useOrganization();
  const { isLoaded: membershipsLoaded, userMemberships } = useOrganizationList({
    userMemberships: { infinite: false },
  });

  const underOrgSubtree = pathname.startsWith("/app/org");

  useEffect(() => {
    if (underOrgSubtree) return;
    if (!authLoaded || !isSignedIn) return;
    if (!orgLoaded || !membershipsLoaded) return;
    if (organization) return;
    if (userMemberships.count > 0) return;

    void navigate({ to: "/app/org/create" });
  }, [
    underOrgSubtree,
    authLoaded,
    isSignedIn,
    orgLoaded,
    membershipsLoaded,
    organization,
    userMemberships.count,
    navigate,
  ]);
}
