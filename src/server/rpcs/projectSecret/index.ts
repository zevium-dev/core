import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema } from "~/db";
import { encryptSecret } from "~/lib/server/crypto-secrets";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

const OrganizationInputZod = z.object({
  organizationId: z.string().optional(),
  organizationSlug: z.string().optional(),
});

const ProjectScopeInputZod = OrganizationInputZod.and(
  z.object({ projectId: z.string().optional(), projectSlug: z.string().optional() }),
);

/** Output schema for secret metadata (never includes ciphertext or plaintext value) */
const SecretMetadataOutputZod = z.object({
  createdAt: z.date(),
  id: z.string(),
  name: z.string(),
  updatedAt: z.date(),
});

export const projectSecretRouter = router({
  /**
   * Create or update a secret by name.
   * If a secret with the same name exists for the project, it will be updated.
   * Otherwise, a new secret will be created.
   */
  createOrUpdateByName: secureProcedure
    .meta({
      requiredPermissions: ["project.edit"],
      route: { path: "/project-secret/create-or-update", summary: "Create or update a project secret" },
    })
    .input(
      ProjectScopeInputZod.and(
        z.object({
          /** Logical name for the secret (e.g. PAYMENT_API_KEY) */
          name: z.string().min(1).max(256),
          /** Plaintext value - will be encrypted before storage */
          value: z.string().min(1),
        }),
      ),
    )
    .output(SecretMetadataOutputZod)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      // Resolve project
      const projectWhere = [orm.eq(schema.project.organizationId, ctx.orgId)];
      if (input.projectId) {
        projectWhere.push(orm.eq(schema.project.id, input.projectId));
      } else if (input.projectSlug) {
        projectWhere.push(orm.eq(schema.project.slug, input.projectSlug));
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either projectId or projectSlug must be provided",
        });
      }

      const project = await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(orm.and(...projectWhere))
        .limit(1)
        .then((v) => v.at(0));

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Encrypt the secret value
      const ciphertext = await encryptSecret(input.value);
      const now = new Date();

      // Check if secret with this name already exists
      const existingSecret = await db
        .select({ id: schema.projectSecret.id })
        .from(schema.projectSecret)
        .where(
          orm.and(orm.eq(schema.projectSecret.projectId, project.id), orm.eq(schema.projectSecret.name, input.name)),
        )
        .limit(1)
        .then((v) => v.at(0));

      if (existingSecret) {
        // Update existing secret
        const updated = await db
          .update(schema.projectSecret)
          .set({
            ciphertext,
            updatedAt: now,
          })
          .where(orm.eq(schema.projectSecret.id, existingSecret.id))
          .returning()
          .then((v) => v.at(0));

        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to update secret",
          });
        }

        return {
          createdAt: updated.createdAt,
          id: updated.id,
          name: updated.name,
          updatedAt: updated.updatedAt,
        };
      }

      // Create new secret
      const newSecret = await db
        .insert(schema.projectSecret)
        .values({
          ciphertext,
          createdAt: now,
          id: createId(),
          name: input.name,
          projectId: project.id,
          updatedAt: now,
        })
        .returning()
        .then((v) => v.at(0));

      if (!newSecret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create secret",
        });
      }

      return {
        createdAt: newSecret.createdAt,
        id: newSecret.id,
        name: newSecret.name,
        updatedAt: newSecret.updatedAt,
      };
    }),

  /**
   * Delete a secret by ID.
   */
  delete: secureProcedure
    .meta({
      requiredPermissions: ["project.edit"],
      route: { path: "/project-secret/delete", summary: "Delete a project secret" },
    })
    .input(ProjectScopeInputZod.and(z.object({ secretId: z.string() })))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      // Resolve project
      const projectWhere = [orm.eq(schema.project.organizationId, ctx.orgId)];
      if (input.projectId) {
        projectWhere.push(orm.eq(schema.project.id, input.projectId));
      } else if (input.projectSlug) {
        projectWhere.push(orm.eq(schema.project.slug, input.projectSlug));
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either projectId or projectSlug must be provided",
        });
      }

      const project = await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(orm.and(...projectWhere))
        .limit(1)
        .then((v) => v.at(0));

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Delete the secret (only if it belongs to this project)
      const deleted = await db
        .delete(schema.projectSecret)
        .where(
          orm.and(orm.eq(schema.projectSecret.id, input.secretId), orm.eq(schema.projectSecret.projectId, project.id)),
        )
        .returning()
        .then((v) => v.at(0));

      return { success: !!deleted };
    }),

  /**
   * List all secrets for a project.
   * Returns metadata only - never includes ciphertext or plaintext values.
   */
  list: secureProcedure
    .meta({
      requiredPermissions: ["project.view"],
      route: { path: "/project-secret/list", summary: "List project secrets (metadata only)" },
    })
    .input(ProjectScopeInputZod)
    .output(z.array(SecretMetadataOutputZod))
    .query(async ({ ctx, input }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Organization ID not found in context",
        });
      }

      // Resolve project
      const projectWhere = [orm.eq(schema.project.organizationId, ctx.orgId)];
      if (input.projectId) {
        projectWhere.push(orm.eq(schema.project.id, input.projectId));
      } else if (input.projectSlug) {
        projectWhere.push(orm.eq(schema.project.slug, input.projectSlug));
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either projectId or projectSlug must be provided",
        });
      }

      const project = await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(orm.and(...projectWhere))
        .limit(1)
        .then((v) => v.at(0));

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Get all secrets for this project (metadata only, no ciphertext)
      const secrets = await db
        .select({
          createdAt: schema.projectSecret.createdAt,
          id: schema.projectSecret.id,
          name: schema.projectSecret.name,
          updatedAt: schema.projectSecret.updatedAt,
        })
        .from(schema.projectSecret)
        .where(orm.eq(schema.projectSecret.projectId, project.id))
        .orderBy(schema.projectSecret.name);

      return secrets;
    }),
});
