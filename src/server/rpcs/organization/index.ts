import { TRPCError } from "@trpc/server";
import { type } from "arktype";
import { z } from "zod";

import { db, orm, schema, schemaZod } from "~/db";
import { type AssignableOrganizationRole, AssignableOrganizationRoles } from "~/db/default-roles";
import { MetadataZod } from "~/db/zod";
import { authServer } from "~/lib/server/auth";
import { secureProcedure } from "~/server/secure-procedure";
import { protectedProcedure, router } from "~/server/trpc";

const OrganizationInputZod = z.object({
  organizationId: z.string().optional(),
  organizationSlug: z.string().optional(),
});

export const organizationRouter = router({
  acceptInvitation: protectedProcedure
    .meta({
      requiredPermissions: ["dashboard.view"],
      route: { path: "/organization/accept-invitation", summary: "Accept a pending invitation" },
    })
    .input(z.object({ invitationId: z.string() }))
    .output(schemaZod.MemberSelectZod)
    .mutation(async ({ ctx, input }) => {
      const member = await authServer.api.acceptInvitation({
        body: { invitationId: input.invitationId },
        headers: ctx.raw.req.headers,
      });

      return schemaZod.MemberSelectZod.parse(member);
    }),

  cancelInvitation: secureProcedure
    .meta({
      requiredPermissions: ["organization.members.invite"],
      route: { path: "/organization/cancel-invitation", summary: "Cancel a pending invitation" },
    })
    .input(OrganizationInputZod.and(z.object({ invitationId: z.string() })))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      const invitation = await db
        .select()
        .from(schema.invitation)
        .where(orm.eq(schema.invitation.id, input.invitationId))
        .then((rows) => rows.at(0));

      if (!invitation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invitation not found",
        });
      }

      if (invitation.organizationId !== ctx.orgId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This invitation does not belong to your organization",
        });
      }

      await db.delete(schema.invitation).where(orm.eq(schema.invitation.id, input.invitationId));

      return { success: true };
    }),

  create: secureProcedure
    .meta({
      requiredPermissions: ["organization.create"],
      route: { path: "/organization/create", summary: "Create new organization" },
    })
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
    .output(schemaZod.OrganizationSelectZod.and(z.object({ members: z.array(schemaZod.MemberSelectZod) })).nullable())
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
      return {
        ...org,
        createdAt: org.createdAt,
        logo: org.logo ?? null,
        members: org.members.filter(Boolean),
        polarBillingEmail: null,
        polarCustomerId: null,
      } as never;
    }),

  delete: secureProcedure
    .meta({
      requiredPermissions: ["organization.delete"],
      route: { path: "/organization/delete", summary: "Delete an organization" },
    })
    .input(OrganizationInputZod)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      await db.delete(schema.organization).where(orm.eq(schema.organization.id, ctx.orgId));

      return { success: true };
    }),

  get: secureProcedure
    .meta({
      requiredPermissions: ["organization.view"],
      route: { path: "/organization/get", summary: "Get organization by ID or slug" },
    })
    .input(type({ organizationId: "string" }).or(type({ organizationSlug: "string" })))
    .output(
      schemaZod.OrganizationSelectZod.and(
        z.object({
          members: z.array(
            schemaZod.MemberSelectZod.and(
              z.object({ user: schemaZod.UserSelectZod.pick({ email: true, image: true, name: true }) }),
            ),
          ),
        }),
      ).and(z.object({ invitations: z.array(schemaZod.InvitationSelectZod) })),
    )
    .query(async ({ ctx, input }) => {
      const org = await authServer.api.getFullOrganization({
        headers: ctx.raw.req.headers,
        query: input,
      });
      if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });

      // Just some type gymnastics to ensure the output is correctly typed
      const uniqueInvitationsMap = new Map<string, (typeof org)["invitations"][number]>();
      for (const inv of org.invitations) {
        if (inv.status !== "pending") continue;
        const existing = uniqueInvitationsMap.get(inv.email);
        if (!existing || new Date(inv.expiresAt) > new Date(existing.expiresAt)) {
          uniqueInvitationsMap.set(inv.email, inv);
        }
      }

      return {
        ...org,
        createdAt: org.createdAt,
        invitations: Array.from(uniqueInvitationsMap.values()),
        logo: org.logo ?? null,
        members: org.members.map((m) => ({ ...m, user: { ...m.user, image: m.user.image ?? null } })),
        metadata: MetadataZod.parse(org.metadata),
        name: org.name,
        polarBillingEmail: null,
        polarCustomerId: null,
        slug: org.slug,
      };
    }),

  inviteMember: secureProcedure
    .meta({
      requiredPermissions: ["organization.members.invite"],
      route: { path: "/organization/invite-member", summary: "Invite a member to organization" },
    })
    .input(
      OrganizationInputZod.and(
        z.object({
          email: z.email({ error: "Invalid email address" }),
          role: z.enum(AssignableOrganizationRoles).optional(),
        }),
      ),
    )
    .output(schemaZod.InvitationSelectZod)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      const normalizedRole: AssignableOrganizationRole = input.role ?? "member";

      // Delete all existing invitations for this email and organization to avoid duplicates
      await db
        .delete(schema.invitation)
        .where(
          orm.and(orm.eq(schema.invitation.organizationId, ctx.orgId), orm.eq(schema.invitation.email, input.email)),
        );

      const invitation = await authServer.api.createInvitation({
        body: {
          email: input.email,
          organizationId: ctx.orgId,
          role: normalizedRole,
        },
        headers: ctx.raw.req.headers,
      });

      return schemaZod.InvitationSelectZod.parse(invitation);
    }),

  // TODO: move this out of this file
  list: secureProcedure
    .meta({
      requiredPermissions: ["organization.list"],
      route: { path: "/organization/list", summary: "Get all user organizations" },
    })
    .output(z.array(schemaZod.OrganizationSelectZod))
    .query(async ({ ctx }) => {
      const orgs = await authServer.api.listOrganizations({ headers: ctx.raw.req.headers });
      return orgs.map((org) => ({
        ...org,
        createdAt: org.createdAt,
        logo: org.logo ?? null,
        metadata: MetadataZod.parse(org.metadata),
        name: org.name,
        polarBillingEmail: null,
        polarCustomerId: null,
        slug: org.slug,
      }));
    }),

  removeMember: secureProcedure
    .meta({
      requiredPermissions: ["organization.members.remove"],
      route: { path: "/organization/remove-member", summary: "Remove a member from organization" },
    })
    .input(
      OrganizationInputZod.and(
        z.object({
          memberId: z.string(),
        }),
      ),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      const memberToRemove = await db
        .select()
        .from(schema.member)
        .where(orm.and(orm.eq(schema.member.id, input.memberId), orm.eq(schema.member.organizationId, ctx.orgId)))
        .then((rows) => rows.at(0));

      if (!memberToRemove) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      }

      // Prevent self-removal
      if (memberToRemove.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot remove yourself from the organization",
        });
      }

      const [{ count: totalMembers }] = await db
        .select({ count: orm.count() })
        .from(schema.member)
        .where(orm.eq(schema.member.organizationId, ctx.orgId));

      if (totalMembers <= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot remove the last member of the organization",
        });
      }

      const [{ count: ownerCount }] = await db
        .select({ count: orm.count() })
        .from(schema.member)
        .where(orm.and(orm.eq(schema.member.organizationId, ctx.orgId), orm.eq(schema.member.role, "owner")));

      if (memberToRemove.role === "owner" && ownerCount <= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "An organization must retain at least one owner",
        });
      }

      // Delete the member from the organization
      await db
        .delete(schema.member)
        .where(orm.and(orm.eq(schema.member.id, input.memberId), orm.eq(schema.member.organizationId, ctx.orgId)));

      return { success: true };
    }),

  update: secureProcedure
    .meta({
      requiredPermissions: ["organization.edit"],
      route: { path: "/organization/update", summary: "Update organization details" },
    })
    .input(
      OrganizationInputZod.and(
        z
          .object({
            logo: z.string().max(128_000).nullable().optional(),
            metadata: MetadataZod.optional(),
            name: z.string().min(3).max(96).optional(),
            slug: z
              .string()
              .min(4)
              .max(64)
              // URL safe characters only
              .regex(/^[a-zA-Z0-9-_]+$/)
              .toLowerCase()
              .optional(),
          })
          .refine(
            (data) =>
              data.logo !== undefined ||
              data.metadata !== undefined ||
              data.name !== undefined ||
              data.slug !== undefined,
            { message: "At least one field must be provided" },
          ),
      ),
    )
    .output(schemaZod.OrganizationSelectZod)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      const updatePayload: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name?: string;
        slug?: string;
      } = {};

      if (input.name) updatePayload.name = input.name;
      if (input.slug) updatePayload.slug = input.slug;
      if (input.logo) updatePayload.logo = input.logo;
      if (input.metadata) updatePayload.metadata = input.metadata;

      const org = await authServer.api.updateOrganization({
        body: {
          data: updatePayload,
          organizationId: ctx.orgId,
        },
        headers: ctx.raw.req.headers,
      });

      if (!org) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization not found",
        });
      }

      return {
        ...org,
        logo: org.logo ?? null,
        metadata: MetadataZod.parse(org.metadata),
        name: org.name,
        polarBillingEmail: null,
        polarCustomerId: null,
        slug: org.slug,
      };
    }),

  updateMemberRole: secureProcedure
    .meta({
      requiredPermissions: ["organization.members.permission.edit"],
      route: { path: "/organization/update-member-role", summary: "Update member role" },
    })
    .input(OrganizationInputZod.and(z.object({ memberId: z.string(), role: z.enum(AssignableOrganizationRoles) })))
    .output(schemaZod.MemberSelectZod)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      const members = await db
        .select()
        .from(schema.member)
        .where(orm.and(orm.eq(schema.member.id, input.memberId), orm.eq(schema.member.organizationId, ctx.orgId)));

      const member = members.at(0);

      if (!member) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      }

      // Prevent self-role-changes
      if (member.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot change your own role",
        });
      }

      const [{ count: totalMembers }] = await db
        .select({ count: orm.count() })
        .from(schema.member)
        .where(orm.eq(schema.member.organizationId, ctx.orgId));

      if (totalMembers <= 1 && input.role !== "owner") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The sole member of an organization must remain an owner",
        });
      }

      const [{ count: ownerCount }] = await db
        .select({ count: orm.count() })
        .from(schema.member)
        .where(orm.and(orm.eq(schema.member.organizationId, ctx.orgId), orm.eq(schema.member.role, "owner")));

      if (member.role === "owner" && ownerCount <= 1 && input.role !== "owner") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "An organization must always have at least one owner",
        });
      }

      // Update the member's role
      const updatedMember = await db
        .update(schema.member)
        .set({ role: input.role })
        .where(orm.and(orm.eq(schema.member.id, input.memberId), orm.eq(schema.member.organizationId, ctx.orgId)))
        .returning()
        .then((rows) => rows.at(0));

      if (!updatedMember) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Member not found",
        });
      }

      return schemaZod.MemberSelectZod.parse(updatedMember);
    }),

  userInvitations: protectedProcedure
    .meta({
      requiredPermissions: ["dashboard.view"],
      route: { path: "/organization/user-invitations", summary: "Get pending invitations for current user" },
    })
    .output(z.array(schemaZod.InvitationSelectZod.and(z.object({ organization: schemaZod.OrganizationSelectZod }))))
    .query(async ({ ctx }) => {
      const invitations = await db
        .select({
          invitation: schema.invitation,
          organization: schema.organization,
        })
        .from(schema.invitation)
        .leftJoin(schema.organization, orm.eq(schema.invitation.organizationId, schema.organization.id))
        .where(orm.and(orm.eq(schema.invitation.email, ctx.user.email), orm.eq(schema.invitation.status, "pending")));

      const uniqueInvitationsMap = new Map<string, (typeof invitations)[number]>();
      for (const row of invitations) {
        if (!row.organization) continue;
        const existing = uniqueInvitationsMap.get(row.organization.id);
        if (!existing || row.invitation.expiresAt > existing.invitation.expiresAt) {
          uniqueInvitationsMap.set(row.organization.id, row);
        }
      }

      return Array.from(uniqueInvitationsMap.values())
        .filter((row): row is { organization: NonNullable<(typeof row)["organization"]> } & typeof row =>
          Boolean(row.organization),
        )
        .map((row) => ({
          ...row.invitation,
          organization: {
            ...row.organization,
            logo: row.organization.logo ?? null,
            metadata: MetadataZod.parse(row.organization.metadata),
          },
        }));
    }),
});
