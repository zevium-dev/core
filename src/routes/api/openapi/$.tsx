import { createServerFileRoute } from "@tanstack/react-start/server";

import { openApiHandler } from "~/server/orpc";

export const ServerRoute = createServerFileRoute("/api/openapi/$").methods({
  GET: ({ request }) => {
    return openApiHandler(request);
  },
  POST: ({ request }) => {
    return openApiHandler(request);
  },
});
