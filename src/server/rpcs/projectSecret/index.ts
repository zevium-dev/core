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

/**
 * Resolve a project ID from either projectId or projectSlug within an organization.
 * @throws {TRPCError} if neither is provided or if the project is not found.
 */
async function resolveProject(orgId: string, input: { projectId?: string; projectSlug?: string }) {
  const projectWhere = [orm.eq(schema.project.organizationId, orgId)];
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

  return project;
}

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
          value: z.string().min(1).max(1_000_000),
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
      const project = await resolveProject(ctx.orgId, input);

      const now = new Date();

      return await db.transaction(async (tx) => {
        // Check existence and encrypt in parallel for better performance
        const [existingSecret, ciphertext] = await Promise.all([
          tx
            .select({ id: schema.projectSecret.id })
            .from(schema.projectSecret)
            .where(
              orm.and(
                orm.eq(schema.projectSecret.projectId, project.id),
                orm.eq(schema.projectSecret.name, input.name),
              ),
            )
            .limit(1)
            .then((v) => v.at(0)),
          encryptSecret(input.value),
        ]);

        if (existingSecret) {
          // Update existing secret
          const updated = await tx
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

          // Audit log: secret update
          await tx.insert(schema.auditLog).values({
            action: "secret.update",
            createdAt: now,
            id: createId(),
            metadata: { name: updated.name },
            organizationId: ctx.orgId,
            projectId: project.id,
            resourceId: updated.id,
            resourceType: "project_secret",
            userId: ctx.user.id,
          });

          return {
            createdAt: updated.createdAt,
            id: updated.id,
            name: updated.name,
            updatedAt: updated.updatedAt,
          };
        }

        // Create new secret
        const newSecret = await tx
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

        // Audit log: secret creation
        await tx.insert(schema.auditLog).values({
          action: "secret.create",
          createdAt: now,
          id: createId(),
          metadata: { name: newSecret.name },
          organizationId: ctx.orgId,
          projectId: project.id,
          resourceId: newSecret.id,
          resourceType: "project_secret",
          userId: ctx.user.id,
        });

        return {
          createdAt: newSecret.createdAt,
          id: newSecret.id,
          name: newSecret.name,
          updatedAt: newSecret.updatedAt,
        };
      });
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
      const project = await resolveProject(ctx.orgId, input);

      return await db.transaction(async (tx) => {
        // Delete the secret (only if it belongs to this project)
        const deleted = await tx
          .delete(schema.projectSecret)
          .where(
            orm.and(
              orm.eq(schema.projectSecret.id, input.secretId),
              orm.eq(schema.projectSecret.projectId, project.id),
            ),
          )
          .returning()
          .then((v) => v.at(0));

        if (deleted) {
          // Audit log: secret deletion
          await tx.insert(schema.auditLog).values({
            action: "secret.delete",
            createdAt: new Date(),
            id: createId(),
            metadata: { name: deleted.name },
            organizationId: ctx.orgId,
            projectId: project.id,
            resourceId: deleted.id,
            resourceType: "project_secret",
            userId: ctx.user.id,
          });
        }

        return { success: !!deleted };
      });
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
      const project = await resolveProject(ctx.orgId, input);

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
