import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { ConvexHttpClient } from "convex/browser";

import { api } from "#/lib/convex-api";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

export type EnsureMirrorResult = {
  userId: string | null;
  orgId: string | null;
  orgSlug: string | null;
  mirrored: boolean;
  /** Last soft-failure reason; empty when ok or unsigned. */
  error: string | null;
};

/**
 * SSR + client navigation: mint Convex JWT, ensure users + organizations
 * mirror rows exist before authed loader queries run.
 * Failures soft — client useEnsureMirror is fallback.
 *
 * Must live in a normal module (not *.server.ts) so route loaders can import
 * the createServerFn RPC stub on the client without import-protection mocks.
 */
export const ensureMirrorOnServer = createServerFn({ method: "GET" }).handler(
  async (): Promise<EnsureMirrorResult> => {
    const session = await auth();
    const userId = session.userId ?? null;
    const orgId = session.orgId ?? null;
    const orgSlug = session.orgSlug ?? null;

    if (!userId) {
      return {
        userId: null,
        orgId: null,
        orgSlug: null,
        mirrored: false,
        error: null,
      };
    }

    if (typeof convexUrl !== "string" || convexUrl.length === 0) {
      return {
        userId,
        orgId,
        orgSlug,
        mirrored: false,
        error: "missing VITE_CONVEX_URL",
      };
    }

    const token = (await session.getToken({ template: "convex" })) ?? null;
    if (!token) {
      return {
        userId,
        orgId,
        orgSlug,
        mirrored: false,
        error: "no convex JWT",
      };
    }

    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(token);

    try {
      await client.mutation(api.users.ensureUser, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        userId,
        orgId,
        orgSlug,
        mirrored: false,
        error: `ensureUser: ${message}`,
      };
    }

    if (!orgId || !orgSlug) {
      // User mirrored; no active org to mirror.
      return {
        userId,
        orgId,
        orgSlug,
        mirrored: true,
        error: null,
      };
    }

    try {
      let name = orgSlug;
      let imageUrl: string | undefined;
      try {
        const org = await (
          await clerkClient()
        ).organizations.getOrganization({ organizationId: orgId });
        if (typeof org.name === "string" && org.name.length > 0) {
          name = org.name;
        }
        if (typeof org.imageUrl === "string" && org.imageUrl.length > 0) {
          imageUrl = org.imageUrl;
        }
      } catch {
        // Clerk lookup optional — slug is enough for mirror row.
      }

      await client.mutation(api.organizations.ensureOrganization, {
        clerkOrgId: orgId,
        name,
        slug: orgSlug,
        imageUrl,
      });
      return {
        userId,
        orgId,
        orgSlug,
        mirrored: true,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        userId,
        orgId,
        orgSlug,
        mirrored: false,
        error: `ensureOrganization: ${message}`,
      };
    }
  },
);
