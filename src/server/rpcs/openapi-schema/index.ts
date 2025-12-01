import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";

import { db, orm, schema } from "~/db";
import { secureProcedure } from "~/server/secure-procedure";
import { router } from "~/server/trpc";

import { parseOpenApiDraft } from "./parse-draft";

const ProjectInputZod = z.object({
  projectId: z.string().optional(),
  projectSlug: z.string().optional(),
});

const parseDraftOrThrow = (draft: string) => {
  try {
    return parseOpenApiDraft(draft);
  } catch (error) {
    throw new TRPCError({
      cause: error instanceof Error ? error : undefined,
      code: "BAD_REQUEST",
      message: error instanceof Error ? error.message : "Invalid OpenAPI spec. Provide valid JSON or YAML.",
    });
  }
};

export const openapiSchemaRouter = router({
  getDraft: secureProcedure
    .meta({
      requiredPermissions: ["project.spec.view"],
      route: { path: "/openapi-schema/get-draft", summary: "Get the current OpenAPI spec draft" },
    })
    .input(ProjectInputZod)
    .output(z.object({ draft: z.string().nullable(), updatedAt: z.date().nullable() }))
    .query(async ({ ctx }) => {
      if (!ctx.projectId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Project ID not found in context",
        });
      }

      const row = await db
        .select()
        .from(schema.openAPISchema)
        .where(orm.eq(schema.openAPISchema.projectId, ctx.projectId))
        .limit(1)
        .then((rows) => rows.at(0));

      if (!row) {
        return { draft: null, updatedAt: null };
      }

      // The schema defines draft as json, but we might want to handle it as string for editing
      // If it's stored as JSON object in DB, we need to stringify it.
      // Checking schema.ts: draft: text("draft", { mode: "json" })
      const draftString = row.draft ? JSON.stringify(row.draft, null, 2) : "";

      return {
        draft: draftString === "{}" ? "" : draftString,
        updatedAt: row.updatedAt,
      };
    }),

  listVersions: secureProcedure
    .meta({
      requiredPermissions: ["project.spec.view"],
      route: { path: "/openapi-schema/list-versions", summary: "List published versions" },
    })
    .input(ProjectInputZod)
    .output(z.array(z.object({ createdAt: z.date(), id: z.string(), schema: z.string(), version: z.string() })))
    .query(async ({ ctx }) => {
      if (!ctx.projectId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Project ID not found in context",
        });
      }

      // We need to join to get versions for this project
      const versions = await db
        .select({
          createdAt: schema.openAPISchemaVersion.createdAt,
          id: schema.openAPISchemaVersion.id,
          schema: schema.openAPISchemaVersion.schema,
          version: schema.openAPISchemaVersion.version,
        })
        .from(schema.openAPISchemaVersion)
        .innerJoin(schema.openAPISchema, orm.eq(schema.openAPISchemaVersion.openAPISchemaId, schema.openAPISchema.id))
        .where(orm.eq(schema.openAPISchema.projectId, ctx.projectId))
        .orderBy(orm.desc(schema.openAPISchemaVersion.createdAt));

      return versions.map((versionRecord) => ({
        ...versionRecord,
        schema: typeof versionRecord.schema === "string" ? versionRecord.schema : JSON.stringify(versionRecord.schema),
      }));
    }),

  publish: secureProcedure
    .meta({
      requiredPermissions: ["project.publish"],
      route: { path: "/openapi-schema/publish", summary: "Publish a new version of the OpenAPI spec" },
    })
    .input(ProjectInputZod.and(z.object({ draft: z.string(), version: z.string() })))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.projectId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Project ID not found in context",
        });
      }

      const parsedDraft = parseDraftOrThrow(input.draft);

      // 1. Ensure the parent schema record exists and is up to date
      const openApiSchema = await db
        .insert(schema.openAPISchema)
        .values({
          draft: parsedDraft,
          id: createId(),
          projectId: ctx.projectId,
        })
        .onConflictDoUpdate({
          set: {
            draft: parsedDraft,
            updatedAt: new Date(),
          },
          target: schema.openAPISchema.projectId,
        })
        .returning()
        .then((rows) => rows.at(0));

      if (!openApiSchema) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to save schema",
        });
      }

      // 2. Create the version
      await db.insert(schema.openAPISchemaVersion).values({
        id: createId(),
        openAPISchemaId: openApiSchema.id,
        schema: parsedDraft,
        version: input.version,
      });

      return { success: true };
    }),

  saveDraft: secureProcedure
    .meta({
      requiredPermissions: ["project.spec.edit"],
      route: { path: "/openapi-schema/save-draft", summary: "Save the OpenAPI spec draft" },
    })
    .input(ProjectInputZod.and(z.object({ draft: z.string() })))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.projectId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Project ID not found in context",
        });
      }

      const parsedDraft = parseDraftOrThrow(input.draft);

      await db
        .insert(schema.openAPISchema)
        .values({
          draft: parsedDraft,
          id: createId(),
          projectId: ctx.projectId,
        })
        .onConflictDoUpdate({
          set: {
            draft: parsedDraft,
            updatedAt: new Date(),
          },
          target: schema.openAPISchema.projectId,
        });

      return { success: true };
    }),
});
