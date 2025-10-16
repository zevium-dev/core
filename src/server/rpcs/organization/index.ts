import { type } from "arktype";
import { z } from "zod";

import { schemaZod } from "~/db";
import { authServer } from "~/lib/server/auth";
import { protectedProcedure, router } from "~/server/trpc";

export const organizationRouter = router({
  create: protectedProcedure
    .meta({ route: { path: "/organization/create", summary: "Create new organization" } })
    .input(
      z.object({
        logo: z.string().max(128_000).optional(),
        name: z.string().min(3).max(96),
        slug: z
          .string()
          .min(4)
          .max(64)
          // URL safe characters only
          .regex(/^[a-zA-Z0-9-_]+$/)
          .toLowerCase(),
      }),
    )
    .output(schemaZod.OrganizationZod.and(z.object({ members: z.array(schemaZod.MemberZod) })).nullable())
    .mutation(async ({ ctx, input }) => {
      const org = await authServer.api.createOrganization({
        body: {
          keepCurrentActiveOrganization: true,
          logo: input.logo,
          metadata: {
            createdBy: ctx.user.id,
          },
          name: input.name,
          slug: input.slug,
          userId: ctx.user.id,
        },
        headers: ctx.raw.req.headers,
      });
      if (!org) return null;
      return { ...org, createdAt: org.createdAt, logo: org.logo ?? null, members: org.members.filter(Boolean) };
    }),

  get: protectedProcedure
    .meta({ route: { path: "/organization/get", summary: "Get organization by ID or slug" } })
    .input(type({ organizationId: "string" }).or(type({ organizationSlug: "string" })))
    .output(
      schemaZod.OrganizationZod.and(
        z.object({
          members: z.array(
            schemaZod.MemberZod.and(
              z.object({ user: schemaZod.UserZod.pick({ email: true, image: true, name: true }) }),
            ),
          ),
        }),
      )
        .and(z.object({ invitations: z.array(schemaZod.InvitationZod) }))
        .nullable(),
    )
    .query(async ({ ctx, input }) => {
      const org = await authServer.api.getFullOrganization({
        headers: ctx.raw.req.headers,
        query: input,
      });
      if (!org) return null;

      // Just some type gymnastics to ensure the output is correctly typed
      return {
        ...org,
        createdAt: org.createdAt,
        logo: org.logo ?? null,
        members: org.members.map((m) => ({ ...m, user: { ...m.user, image: m.user.image ?? null } })),
        metadata: org.metadata as Record<string, unknown>,
      };
    }),

  list: protectedProcedure
    .meta({ route: { path: "/organization/list", summary: "Get all user organizations" } })
    .output(z.array(schemaZod.OrganizationZod))
    .query(async ({ ctx }) => {
      const orgs = await authServer.api.listOrganizations({ headers: ctx.raw.req.headers });
      return orgs.map((org) => ({
        ...org,
        createdAt: org.createdAt,
        logo: org.logo ?? null,
        metadata: org.metadata as Record<string, unknown>,
      }));
    }),
});
