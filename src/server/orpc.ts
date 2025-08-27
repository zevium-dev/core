import { experimental_ArkTypeToJsonSchemaConverter as ArkTypeToJsonSchemaConverter } from "@orpc/arktype";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch"; // or '@orpc/server/node'
import { onError, ORPCError } from "@orpc/server";
import { CORSPlugin } from "@orpc/server/plugins";
import { toORPCRouter } from "@orpc/trpc";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4"; // <-- zod v4
import { TRPCError } from "@trpc/server";
import { type } from "arktype";
import { z, ZodError } from "zod";

import packageJson from "~/../package.json" with { type: "json" };
import { clientEnv } from "~/env/client";

import { createServerContext } from "./context";
import { appRouter } from "./index";

const orpcRouter = toORPCRouter(appRouter);

const openAPIGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter(), new ArkTypeToJsonSchemaConverter()],
});

// Improve startup time by generating the OpenAPI spec lazily on first request and caching it
export const openApiSpec = await openAPIGenerator.generate(orpcRouter, {
  components: { securitySchemes: { bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" } } },
  info: { title: "zevium", version: packageJson.version },
  security: [{ bearerAuth: [] }],
  servers: [{ url: `${clientEnv.VITE_PUBLIC_URL}/api/openapi` }],
});

const _openApiHandler = new OpenAPIHandler(orpcRouter, {
  interceptors: [
    onError((error) => {
      if (error instanceof ORPCError && error.cause instanceof TRPCError) {
        if (error.cause.cause instanceof ZodError) {
          throw new ORPCError("INPUT_VALIDATION_FAILED", {
            cause: error.cause.cause,
            data: z.treeifyError(error.cause.cause),
            status: 422,
          });
        } else if (error.cause.cause instanceof type.errors) {
          throw new ORPCError("INPUT_VALIDATION_FAILED", {
            cause: error.cause.cause,
            data: error.cause.cause.summary,
            status: 422,
          });
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }),
  ],
  plugins: [new CORSPlugin()],
});

export const openApiHandler = async (request: Request): Promise<Response> => {
  const { matched, response } = await _openApiHandler.handle(request, {
    context: await createServerContext({ req: request }),
    prefix: "/api/openapi",
  });
  if (matched) return response;

  if (request.url === `${clientEnv.VITE_PUBLIC_URL}/api/openapi/spec.json`) {
    return Response.json(openApiSpec);
  }

  if (request.url === `${clientEnv.VITE_PUBLIC_URL}/api/openapi`) {
    return new Response(createScalarHtml({ specUrl: "/api/openapi/spec.json" }), {
      headers: { "Content-Type": "text/html" },
    });
  }

  return new Response("Not Found", { status: 404 });
};

const createScalarHtml = (options: { bearerToken?: string; specUrl?: string; title?: string }) => {
  const html = /* html */ `
    <!doctype html>
    <html>
      <head>
        <title>${options.title ?? "Zevium OpenAPI"}</title>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="https://orpc.unnoq.com/icon.svg" />
        <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference">
        </script>
      </head>
      <body>
        <div id="app"></div>

        <script>
          Scalar.createApiReference('#app', {
            url: '${options.specUrl ?? "/api/openapi/spec.json"}',
            authentication: {
              securitySchemes: {
                bearerAuth: {
                  token: '${options.bearerToken ?? "default-token"}',
                },
              },
            },
          })
        </script>
      </body>
    </html>`;
  return html;
};
