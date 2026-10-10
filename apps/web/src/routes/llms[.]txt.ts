import { createFileRoute } from "@tanstack/react-router";

import { llmsResponse } from "#/lib/llms";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: ({ request }) =>
        llmsResponse(request, import.meta.env.VITE_GATEWAY_URL),
    },
  },
});
