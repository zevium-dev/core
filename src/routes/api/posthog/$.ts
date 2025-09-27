import { createFileRoute } from "@tanstack/react-router";

const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";

const posthogProxy = async (request: Request) => {
  const url = new URL(request.url);
  const hostname = url.pathname.startsWith("/api/posthog/static/") ? ASSET_HOST : API_HOST;

  const newUrl = new URL(url);
  newUrl.protocol = "https";
  newUrl.hostname = hostname;
  newUrl.port = "443";
  newUrl.pathname = newUrl.pathname.replace(/^\/api\/posthog/, "");

  const headers = new Headers(request.headers);
  headers.set("host", hostname);

  const response = await fetch(newUrl, {
    body: request.body,
    // @ts-expect-error duplex is not in the type definition # broken nodejs types
    duplex: "half",
    headers,
    method: request.method,
  });

  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export const Route = createFileRoute("/api/posthog/$")({
  server: {
    handlers: {
      GET: ({ request }) => {
        return posthogProxy(request);
      },
      POST: ({ request }) => {
        return posthogProxy(request);
      },
    },
  },
});
