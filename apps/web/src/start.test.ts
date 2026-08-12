import { describe, expect, it, vi } from "vitest";

import { csrfMiddleware, startInstance } from "./start";

type CsrfServer = NonNullable<typeof csrfMiddleware.options.server>;
type CsrfContext = Parameters<CsrfServer>[0];

async function runCsrf(headers: HeadersInit) {
  const next = vi.fn(async () => new Response("handler reached"));
  const server = csrfMiddleware.options.server;
  if (!server) throw new Error("CSRF server middleware is missing");

  const result = await server({
    request: new Request("https://www.zevium.dev/_serverFn/test", {
      method: "POST",
      headers,
    }),
    handlerType: "serverFn",
    context: {},
    pathname: "/_serverFn/test",
    params: {},
    next,
  } as unknown as CsrfContext);
  return { next, result };
}

describe("Start CSRF middleware", () => {
  it("runs before Clerk in the request middleware chain", async () => {
    const options = await startInstance.getOptions();
    expect(options.requestMiddleware?.[0]).toBe(csrfMiddleware);
  });

  it.each([
    ["cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ["same-site", { "Sec-Fetch-Site": "same-site" }],
    ["foreign origin", { Origin: "https://attacker.example" }],
    ["missing browser provenance", {}],
  ])("blocks %s before the handler", async (_label, headers) => {
    const { next, result } = await runCsrf(headers);
    expect(next).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it.each([
    ["Sec-Fetch-Site", { "Sec-Fetch-Site": "same-origin" }],
    ["Origin", { Origin: "https://www.zevium.dev" }],
    ["Referer", { Referer: "https://www.zevium.dev/app/projects" }],
  ])("allows same-origin %s evidence", async (_label, headers) => {
    const { next, result } = await runCsrf(headers);
    expect(next).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });
});
