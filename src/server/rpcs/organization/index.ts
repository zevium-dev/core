import z from "zod";

import {
  createDefaultOrganization,
  createOrganization,
  getOrganizationBySlug,
  getOrganizationMembers,
  getOrganizationProjects,
  getUserOrganizations,
  userHasOrganizations,
} from "~/lib/server/organization-service";
import { protectedProcedure, router } from "~/server/trpc";

// Organization schema for responses
const organizationSchema = z.object({
  createdAt: z.date(),
  description: z.string().nullable(),
  id: z.string(),
  logo: z.string().nullable(),
  memberCount: z.number(),
  name: z.string(),
  ownerId: z.string(),
  projectCount: z.number(),
  settings: z.record(z.string(), z.unknown()),
  slug: z.string(),
  updatedAt: z.date(),
  website: z.string().nullable(),
});

export const organizationRouter = router({
  // Create new organization
  create: protectedProcedure
    .meta({ route: { path: "/organization/create", summary: "Create new organization" } })
    .input(
      z.object({
        description: z.string().optional(),
        name: z.string().min(1, "Organization name is required"),
        website: z.string().url().optional().or(z.literal("")),
      }),
    )
    .output(
      z.object({
        organization: organizationSchema,
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const organization = await createOrganization({
        description: input.description,
        name: input.name,
        userId: ctx.user.id,
        website: input.website,
      });

      return {
        organization,
        success: true,
      };
    }),

  // Create default organization for the current user
  createDefault: protectedProcedure
    .meta({ route: { path: "/organization/create-default", summary: "Create default organization for user" } })
    .input(z.object({}).optional())
    .output(
      z.object({
        organization: z.object({
          createdAt: z.date(),
          description: z.string().nullable(),
          id: z.string(),
          logo: z.string().nullable(),
          name: z.string(),
          ownerId: z.string(),
          settings: z.record(z.string(), z.unknown()),
          slug: z.string(),
          updatedAt: z.date(),
          website: z.string().nullable(),
        }),
        success: z.boolean(),
      }),
    )
    .mutation(async ({ ctx }) => {
      // Check if user already has organizations
      const hasOrganizations = await userHasOrganizations(ctx.user.id);

      if (hasOrganizations) {
        throw new Error("User already has organizations");
      }

      const organization = await createDefaultOrganization({
        userEmail: ctx.user.email,
        userId: ctx.user.id,
        userName: ctx.user.name,
      });

      return {
        organization: {
          ...organization,
          settings: organization.settings as Record<string, unknown>,
        },
        success: true,
      };
    }),
  // Auto-create organization during first login (can be called from client)
  ensureDefaultOrganization: protectedProcedure
    .meta({ route: { path: "/organization/ensure-default", summary: "Ensure user has a default organization" } })
    .input(z.object({}).optional())
    .output(
      z.object({
        created: z.boolean(),
        hasOrganizations: z.boolean(),
        organization: z
          .object({
            createdAt: z.date(),
            description: z.string().nullable(),
            id: z.string(),
            logo: z.string().nullable(),
            name: z.string(),
            ownerId: z.string(),
            settings: z.record(z.string(), z.unknown()),
            slug: z.string(),
            updatedAt: z.date(),
            website: z.string().nullable(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx }) => {
      // Check if user already has organizations
      const hasOrganizations = await userHasOrganizations(ctx.user.id);

      if (hasOrganizations) {
        return {
          created: false,
          hasOrganizations: true,
        };
      }

      // Create default organization
      const organization = await createDefaultOrganization({
        userEmail: ctx.user.email,
        userId: ctx.user.id,
        userName: ctx.user.name,
      });

      return {
        created: true,
        hasOrganizations: true,
        organization: {
          ...organization,
          settings: organization.settings as Record<string, unknown>,
        },
      };
    }),

  // Get organization by slug
  getBySlug: protectedProcedure
    .meta({ route: { path: "/organization/get-by-slug", summary: "Get organization by slug" } })
    .input(
      z.object({
        slug: z.string(),
      }),
    )
    .output(
      z.object({
        organization: organizationSchema.extend({
          userMembership: z.object({
            id: z.string(),
            joinedAt: z.date(),
            permissions: z.record(z.string(), z.unknown()),
            role: z.enum(["owner", "admin", "member"]),
          }),
        }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const organization = await getOrganizationBySlug(input.slug, ctx.user.id);

      if (!organization) {
        throw new Error("Organization not found");
      }

      return {
        organization,
      };
    }),

  // Get organization members
  getMembers: protectedProcedure
    .meta({ route: { path: "/organization/get-members", summary: "Get organization members" } })
    .input(
      z.object({
        organizationId: z.string(),
      }),
    )
    .output(
      z.object({
        members: z.array(
          z.object({
            id: z.string(),
            joinedAt: z.date(),
            permissions: z.record(z.string(), z.unknown()),
            role: z.enum(["owner", "admin", "member"]),
            userEmail: z.string(),
            userId: z.string(),
            userImage: z.string().nullable(),
            userName: z.string(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const members = await getOrganizationMembers(input.organizationId, ctx.user.id);

      return {
        members,
      };
    }),

  // Get organization projects
  getProjects: protectedProcedure
    .meta({ route: { path: "/organization/get-projects", summary: "Get organization projects" } })
    .input(
      z.object({
        organizationId: z.string(),
      }),
    )
    .output(
      z.object({
        projects: z.array(
          z.object({
            createdAt: z.date(),
            createdBy: z.string(),
            creatorName: z.string(),
            description: z.string().nullable(),
            id: z.string(),
            metadata: z.record(z.string(), z.unknown()),
            name: z.string(),
            settings: z.record(z.string(), z.unknown()),
            slug: z.string(),
            status: z.enum(["active", "inactive", "archived", "beta", "deprecated"]),
            updatedAt: z.date(),
            visibility: z.enum(["public", "private", "internal"]),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const projects = await getOrganizationProjects(input.organizationId, ctx.user.id);

      return {
        projects,
      };
    }),

  // Check if user has organizations
  hasOrganizations: protectedProcedure
    .meta({ route: { path: "/organization/has-organizations", summary: "Check if user has organizations" } })
    .output(z.object({ hasOrganizations: z.boolean() }))
    .query(async ({ ctx }) => {
      const hasOrganizations = await userHasOrganizations(ctx.user.id);
      return { hasOrganizations };
    }),

  // Get all user organizations
  list: protectedProcedure
    .meta({ route: { path: "/organization/list", summary: "Get all user organizations" } })
    .output(
      z.object({
        organizations: z.array(organizationSchema),
      }),
    )
    .query(async ({ ctx }) => {
      const organizations = await getUserOrganizations(ctx.user.id);

      return {
        organizations,
      };
    }),
});
