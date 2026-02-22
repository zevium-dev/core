import { createFileRoute } from "@tanstack/react-router";
import { TRPCError } from "@trpc/server";

import { db, orm, schema } from "~/db";
import { createServerContext } from "~/server/context";
import { appRouter } from "~/server/index";

type JsonObject = Record<string, unknown>;

const toErrorResponse = (error: unknown) => {
  if (error instanceof TRPCError) {
    const status =
      error.code === "BAD_REQUEST"
        ? 400
        : error.code === "UNAUTHORIZED"
          ? 401
          : error.code === "FORBIDDEN"
            ? 403
            : error.code === "NOT_FOUND"
              ? 404
              : 500;

    return Response.json({ error: error.message }, { status });
  }

  return Response.json({ error: "Failed to load OpenAPI specification" }, { status: 500 });
};

const parseOpenApiSchema = (value: unknown): JsonObject => {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid OpenAPI schema shape");
    }
    return parsed as JsonObject;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OpenAPI schema shape");
  }

  return value as JsonObject;
};

const substituteTokens = (value: unknown, variables: Map<string, string>): unknown => {
  if (typeof value === "string") {
    return value.replace(/%([^%]+)%/g, (token, variableName: string) => {
      return variables.get(variableName) ?? token;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteTokens(item, variables));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substituteTokens(child, variables)]),
    ) satisfies JsonObject;
  }

  return value;
};

const createVariableMap = (variables: Array<{ name: string; value: string }> | undefined) => {
  const map = new Map<string, string>();

  for (const variable of variables ?? []) {
    const name = variable.name.trim();
    if (!name) continue;
    map.set(name, variable.value);
  }

  return map;
};

const getPublishedSpec = async (request: Request, params: { organizationSlug: string; projectSlug: string }) => {
  const context = await createServerContext({ req: request });
  const caller = appRouter.createCaller(context);

  const project = await caller.project.get({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
  });

  const requestedVersion = new URL(request.url).searchParams.get("version") ?? undefined;

  const whereClauses = [orm.eq(schema.openAPISchema.projectId, project.id)];

  if (requestedVersion) {
    whereClauses.push(orm.eq(schema.openAPISchemaVersion.version, requestedVersion));
  }

  const versionRow = await db
    .select({ schema: schema.openAPISchemaVersion.schema, version: schema.openAPISchemaVersion.version })
    .from(schema.openAPISchemaVersion)
    .innerJoin(schema.openAPISchema, orm.eq(schema.openAPISchemaVersion.openAPISchemaId, schema.openAPISchema.id))
    .where(orm.and(...whereClauses))
    .orderBy(orm.desc(schema.openAPISchemaVersion.createdAt))
    .limit(1)
    .then((rows) => rows.at(0));

  if (!versionRow) {
    return Response.json(
      {
        error: requestedVersion
          ? `Published OpenAPI spec version "${requestedVersion}" not found`
          : "No published OpenAPI spec found",
      },
      { status: 404 },
    );
  }

  const openApiSpec = parseOpenApiSchema(versionRow.schema);
  const substitutedSpec = substituteTokens(openApiSpec, createVariableMap(project.variables ?? undefined));

  return Response.json(substitutedSpec, {
    headers: {
      "cache-control": "no-store",
      "x-zevium-openapi-version": versionRow.version,
    },
  });
};

export const Route = createFileRoute("/api/projects/$organizationSlug/$projectSlug/openapi")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        try {
          return await getPublishedSpec(request, {
            organizationSlug: params.organizationSlug,
            projectSlug: params.projectSlug,
          });
        } catch (error) {
          return toErrorResponse(error);
        }
      },
    },
  },
});
