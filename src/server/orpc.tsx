import { experimental_ArkTypeToJsonSchemaConverter as ArkTypeToJsonSchemaConverter } from "@orpc/arktype";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError, ORPCError } from "@orpc/server";
import { CORSPlugin } from "@orpc/server/plugins";
import { toORPCRouter } from "@orpc/trpc";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { TRPCError } from "@trpc/server";
import { type } from "arktype";
import dedent from "dedent";
import { renderToString } from "react-dom/server";
import { z, ZodError } from "zod";

import packageJson from "~/../package.json" with { type: "json" };
import { memoryCached } from "~/lib/cache";

import { createServerContext } from "./context";
import { appRouter } from "./index";

export const openApiHandler = async (request: Request): Promise<Response> => {
  const createOrpcRouter = memoryCached({ namespace: "orpc-router" }, async () => {
    await Promise.resolve();
    return toORPCRouter(appRouter);
  });
  const orpcRouter = await createOrpcRouter();

  const createHandler = memoryCached({ namespace: "orpc-openapi-handler" }, async () => {
    await Promise.resolve();
    return new OpenAPIHandler(orpcRouter, {
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
  });

  const handler = await createHandler();

  const { matched, response } = await handler.handle(request, {
    context: await createServerContext({ req: request }),
    prefix: "/api/openapi",
  });
  if (matched) return response;

  const url = new URL(request.url);

  if (url.pathname === `/api/openapi/spec.json`) {
    const createOpenApiSpec = memoryCached({ namespace: "orpc-openapi-spec" }, async () => {
      const openAPIGenerator = new OpenAPIGenerator({
        schemaConverters: [new ZodToJsonSchemaConverter(), new ArkTypeToJsonSchemaConverter()],
      });
      const openApiSpec = await openAPIGenerator.generate(orpcRouter, {
        components: { securitySchemes: { bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" } } },
        info: { title: "zevium", version: packageJson.version },
        security: [{ bearerAuth: [] }],
        servers: [{ url: `${url.origin}/api/openapi` }],
      });
      return openApiSpec;
    });
    const openApiSpec = await createOpenApiSpec();
    return Response.json(openApiSpec);
  }

  if (url.pathname === `/api/openapi`) {
    const scalarHtml = await createScalarHtml({ specUrl: "/api/openapi/spec.json" });
    return new Response(scalarHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  return new Response("Not Found", { status: 404 });
};

const createScalarHtml = memoryCached(
  { namespace: "orpc-scalar-html" },
  async (options: { bearerToken?: string; specUrl?: string; title?: string }) => {
    await Promise.resolve();
    const Component = () => {
      return (
        <html lang="en">
          <head>
            <title>{options.title ?? "Zevium OpenAPI"}</title>
            <meta charSet="utf-8" />
            <meta content="width=device-width, initial-scale=1" name="viewport" />
            <meta content="Zevium OpenAPI" name="description" />
            <link href="/icon.png" rel="icon" sizes="256x256" type="image/png" />
            <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference" />
          </head>
          <body>
            <div id="app" />
            <script
              // eslint-disable-next-line @eslint-react/dom/no-dangerously-set-innerhtml
              dangerouslySetInnerHTML={{
                __html: dedent`
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
              `,
              }}
            />
          </body>
        </html>
      );
    };

    const html = renderToString(<Component />);
    return html;
  },
);
