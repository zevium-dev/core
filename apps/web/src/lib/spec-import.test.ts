import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getRequest: vi.fn(),
  mutation: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("@clerk/tanstack-react-start/server", () => ({ auth: mocks.auth }));
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRequest: mocks.getRequest,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = mocks.setAuth;
    mutation = mocks.mutation;
  },
}));
vi.mock("node:dns/promises", () => ({
  resolve4: mocks.resolve4,
  resolve6: mocks.resolve6,
}));

import { MAX_SPEC_IMPORT_BYTES, parseImportSpecUrl } from "./spec-import";
import {
  fetchSpecFromUrlForRequest,
  fetchSpecFromUrlServerBoundary,
  type SpecImportRuntime,
} from "./spec-import.server";

const PUBLIC_SPEC_URL = "https://93.184.216.34/openapi.json";

function authenticatedSession() {
  return {
    isAuthenticated: true,
    userId: "user_importer",
    orgId: "org_importer",
    orgRole: "org:member",
    getToken: vi.fn().mockResolvedValue("convex-token"),
  };
}

async function invoke(url = PUBLIC_SPEC_URL) {
  return await fetchSpecFromUrlServerBoundary({ url });
}

const VALID_SPEC = {
  openapi: "3.1.0",
  info: { title: "Imported API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {},
};

const NORMALIZED_SPEC = `${JSON.stringify(VALID_SPEC, null, 2)}\n`;

function runtimeFixture() {
  const authenticate = vi.fn<SpecImportRuntime["authenticate"]>(async () => ({
    isAuthenticated: true,
    userId: "user_test",
    orgId: "org_test",
  }));
  const resolveHostname = vi.fn(async (_hostname: string) => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) =>
    Response.json(VALID_SPEC, {
      headers: { "content-type": "application/json" },
    }),
  );
  const renew = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const acquirePermit = vi.fn(async () => ({ renew, release }));
  const runtime: SpecImportRuntime = {
    authenticate,
    resolveHostname,
    fetch,
    acquirePermit,
  };
  return {
    runtime,
    authenticate,
    resolveHostname,
    fetch,
    acquirePermit,
    renew,
    release,
  };
}

function cancellableResponse(
  body: string,
  init: ResponseInit,
  onCancel: () => void,
): Response {
  const encoded = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        onCancel();
      },
    }),
    init,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseImportSpecUrl", () => {
  it("accepts only credential-free HTTPS on port 443", () => {
    expect(
      parseImportSpecUrl({ url: "  https://example.com/openapi.json  " }),
    ).toEqual({
      ok: true,
      data: { url: "https://example.com/openapi.json" },
    });
    expect(
      parseImportSpecUrl({ url: "https://example.com:443/spec.yaml" }),
    ).toEqual({
      ok: true,
      data: { url: "https://example.com:443/spec.yaml" },
    });
  });

  it.each([
    "http://example.com/openapi.json",
    "https://example.com:8443/openapi.json",
    "https://user:pass@example.com/openapi.json",
    "ftp://example.com/openapi.json",
    "not-a-url",
    "",
  ])("rejects unsafe URL %j", (url) => {
    expect(parseImportSpecUrl({ url }).ok).toBe(false);
  });
});

describe("fetchSpecFromUrlForRequest", () => {
  it("does zero DNS or fetch work for an anonymous caller", async () => {
    const fixture = runtimeFixture();
    fixture.authenticate.mockResolvedValue({
      isAuthenticated: false,
      userId: null,
      orgId: null,
    });

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Sign in before importing a spec");
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("does zero DNS or fetch work without an active organization", async () => {
    const fixture = runtimeFixture();
    fixture.authenticate.mockResolvedValue({
      isAuthenticated: true,
      userId: "user_test",
      orgId: null,
    });

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Select an organization before importing a spec");
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("maps auth failures and still performs zero network work", async () => {
    const fixture = runtimeFixture();
    fixture.authenticate.mockRejectedValue(new Error("Clerk internals"));

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Could not verify your session");
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("authenticates before DNS and returns a bounded successful body", async () => {
    const fixture = runtimeFixture();
    const result = await fetchSpecFromUrlForRequest(
      { url: "https://example.com/openapi.json" },
      fixture.runtime,
    );

    expect(result).toEqual({
      text: NORMALIZED_SPEC,
      contentType: "application/json",
    });
    expect(fixture.authenticate).toHaveBeenCalledOnce();
    expect(fixture.resolveHostname).toHaveBeenCalledWith("example.com");
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.authenticate.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.acquirePermit.mock.invocationCallOrder[0],
    );
    expect(fixture.acquirePermit.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.resolveHostname.mock.invocationCallOrder[0],
    );
    expect(fixture.resolveHostname.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.fetch.mock.invocationCallOrder[0],
    );
    const [, init] = fixture.fetch.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(new Headers(init.headers).get("accept"))).not.toContain(
      "*/*",
    );
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rejects any mixed DNS answer before fetch", async () => {
    const fixture = runtimeFixture();
    fixture.resolveHostname.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Failed to fetch spec");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1/openapi.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/openapi.json",
    "https://[::ffff:127.0.0.1]/openapi.json",
  ])("rejects non-public literal %s without DNS or fetch", async (url) => {
    const fixture = runtimeFixture();
    await expect(
      fetchSpecFromUrlForRequest({ url }, fixture.runtime),
    ).rejects.toThrow("Failed to fetch spec");
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("cancels a redirect body and revalidates the next host", async () => {
    const fixture = runtimeFixture();
    const cancel = vi.fn();
    fixture.fetch
      .mockResolvedValueOnce(
        cancellableResponse(
          "ignored",
          {
            status: 302,
            headers: { location: "https://cdn.example/spec" },
          },
          cancel,
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `openapi: 3.1.0\ninfo:\n  title: Imported API\n  version: 1.0.0\nservers:\n  - url: https://api.example.com\npaths: {}`,
          { status: 200, headers: { "content-type": "application/yaml" } },
        ),
      );

    const result = await fetchSpecFromUrlForRequest(
      { url: "https://example.com/openapi.json" },
      fixture.runtime,
    );

    expect(result).toEqual({
      text: `openapi: 3.1.0\ninfo:\n  title: Imported API\n  version: 1.0.0\nservers:\n  - url: https://api.example.com\npaths: {}`,
      contentType: "application/yaml",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.resolveHostname).toHaveBeenNthCalledWith(1, "example.com");
    expect(fixture.resolveHostname).toHaveBeenNthCalledWith(2, "cdn.example");
  });

  it("cancels then blocks a redirect to a private address", async () => {
    const fixture = runtimeFixture();
    const cancel = vi.fn();
    fixture.fetch.mockResolvedValue(
      cancellableResponse(
        "ignored",
        { status: 302, headers: { location: "https://127.0.0.1/spec" } },
        cancel,
      ),
    );

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Failed to fetch spec");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("cancels a response rejected by advertised content length", async () => {
    const fixture = runtimeFixture();
    const cancel = vi.fn();
    fixture.fetch.mockResolvedValue(
      cancellableResponse(
        "ignored",
        {
          status: 200,
          headers: {
            "content-length": String(MAX_SPEC_IMPORT_BYTES + 1),
            "content-type": "application/json",
          },
        },
        cancel,
      ),
    );

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Spec is larger than 2MB");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a streamed response once it crosses the byte cap", async () => {
    const fixture = runtimeFixture();
    const cancel = vi.fn();
    fixture.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_SPEC_IMPORT_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancel();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Spec is larger than 2MB");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts a hung fetch at the total wall-clock deadline", async () => {
    vi.useFakeTimers();
    const fixture = runtimeFixture();
    const observedAbort = vi.fn();
    fixture.fetch.mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              observedAbort();
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );

    const pending = fetchSpecFromUrlForRequest(
      { url: "https://example.com/openapi.json" },
      fixture.runtime,
    );
    await Promise.all([
      expect(pending).rejects.toThrow("Failed to fetch spec"),
      vi.advanceTimersByTimeAsync(10_000),
    ]);
    expect(observedAbort).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rejects unsupported MIME before reading body", async () => {
    const fixture = runtimeFixture();
    const cancel = vi.fn();
    fixture.fetch.mockResolvedValue(
      cancellableResponse(
        JSON.stringify(VALID_SPEC),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
        cancel,
      ),
    );
    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("supported JSON or YAML");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("parses then rejects non-OpenAPI and OpenAPI 2 payloads", async () => {
    for (const body of [
      { hello: "world" },
      {
        swagger: "2.0",
        info: { title: "Old", version: "1" },
        paths: {},
      },
    ]) {
      const fixture = runtimeFixture();
      fixture.fetch.mockResolvedValue(Response.json(body));
      await expect(
        fetchSpecFromUrlForRequest(
          { url: "https://example.com/openapi.json" },
          fixture.runtime,
        ),
      ).rejects.toThrow("valid OpenAPI 3 document");
      expect(fixture.release).toHaveBeenCalledOnce();
    }
  });

  it.each([
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "100::1",
    "2001:2::1",
    "3fff::1",
    "5f00::1",
  ])("rejects special-use IPv6 DNS answer %s", async (address) => {
    const fixture = runtimeFixture();
    fixture.resolveHostname.mockResolvedValue([{ address, family: 6 }]);
    await expect(
      fetchSpecFromUrlForRequest(
        { url: "https://example.com/openapi.json" },
        fixture.runtime,
      ),
    ).rejects.toThrow("Failed to fetch spec");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
describe("fetchSpecFromUrl server boundary", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONVEX_URL", "https://convex.example");
    vi.stubEnv("NODE_ENV", "production");
    mocks.getRequest.mockReturnValue(
      new Request("https://www.zevium.dev/_server/import", {
        method: "POST",
        headers: { origin: "https://www.zevium.dev" },
      }),
    );
    mocks.auth.mockResolvedValue(authenticatedSession());
    mocks.mutation.mockResolvedValue({ remaining: 9, resetsAt: Date.now() });
    mocks.resolve4.mockResolvedValue(["93.184.216.34"]);
    mocks.resolve6.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"openapi":"3.1.0"}', {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("requires same-origin POST before auth or network access", async () => {
    mocks.getRequest.mockReturnValue(
      new Request("https://www.zevium.dev/_server/import", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    await expect(invoke()).rejects.toThrow(/origin is not allowed/i);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    mocks.getRequest.mockReturnValue(
      new Request("https://www.zevium.dev/_server/import", { method: "POST" }),
    );
    await expect(invoke()).rejects.toThrow(/origin is not allowed/i);

    mocks.getRequest.mockReturnValue(
      new Request("https://www.zevium.dev/_server/import", {
        method: "POST",
        headers: { origin: "https://www.zevium.dev/not-an-origin" },
      }),
    );
    await expect(invoke()).rejects.toThrow(/origin is not allowed/i);

    mocks.getRequest.mockReturnValue(
      new Request("https://www.zevium.dev/_server/import", {
        method: "GET",
        headers: { origin: "https://www.zevium.dev" },
      }),
    );
    await expect(invoke()).rejects.toThrow(/origin is not allowed/i);
  });

  it("requires a signed-in user with active organization membership", async () => {
    mocks.auth.mockResolvedValueOnce({
      isAuthenticated: false,
      userId: null,
      orgId: null,
      orgRole: null,
    });
    await expect(invoke()).rejects.toThrow(/Sign in/);

    mocks.auth.mockResolvedValueOnce({
      ...authenticatedSession(),
      orgId: null,
      orgRole: null,
    });
    await expect(invoke()).rejects.toThrow(/Select an organization/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("acquires authenticated Convex rate lease before fetching", async () => {
    const result = await invoke();
    expect(mocks.setAuth).toHaveBeenCalledWith("convex-token");
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      text: '{"openapi":"3.1.0"}',
      contentType: "application/json; charset=utf-8",
    });
  });

  it("fails closed when rate lease is denied", async () => {
    mocks.mutation.mockRejectedValueOnce(new Error("rate limit exceeded"));
    await expect(invoke()).rejects.toThrow(/rate limit exceeded/);
    expect(fetch).not.toHaveBeenCalled();

    mocks.mutation.mockRejectedValueOnce(new Error("internal database detail"));
    await expect(invoke()).rejects.toThrow(
      "Spec import is temporarily unavailable",
    );
  });

  it("enforces TLS, MIME, redirect SSRF, and size bounds", async () => {
    await expect(invoke("http://93.184.216.34/openapi.json")).rejects.toThrow(
      /must use HTTPS/,
    );
    await expect(
      invoke("https://user:password@93.184.216.34/openapi.json"),
    ).rejects.toThrow(/must use HTTPS/);
    await expect(invoke("https://[::1]/openapi.json")).rejects.toThrow(
      /Failed to fetch spec/,
    );
    await expect(invoke("https://[::]/openapi.json")).rejects.toThrow(
      /Failed to fetch spec/,
    );
    await expect(
      invoke("https://[::ffff:127.0.0.1]/openapi.json"),
    ).rejects.toThrow(/Failed to fetch spec/);
    await expect(invoke("https://198.51.100.2/openapi.json")).rejects.toThrow(
      /Failed to fetch spec/,
    );
    await expect(invoke("https://[2001:db8::1]/openapi.json")).rejects.toThrow(
      /Failed to fetch spec/,
    );

    mocks.resolve4.mockResolvedValueOnce(["93.184.216.34", "127.0.0.1"]);
    await expect(invoke("https://spec.example/openapi.json")).rejects.toThrow(
      /Failed to fetch spec/,
    );
    expect(fetch).not.toHaveBeenCalled();

    mocks.resolve4.mockRejectedValueOnce(new Error("ENODATA"));
    mocks.resolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(
      invoke("https://missing.example/openapi.json"),
    ).rejects.toThrow(/Failed to fetch spec/);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("<html>nope</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(invoke()).rejects.toThrow(/JSON or YAML/);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/internal" },
      }),
    );
    await expect(invoke()).rejects.toThrow(/Failed to fetch spec/);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("{}", {
        headers: {
          "content-type": "application/yaml",
          "content-length": String(MAX_SPEC_IMPORT_BYTES + 1),
        },
      }),
    );
    await expect(invoke()).rejects.toThrow(/larger than 2MB/);
  });

  it("enforces redirect and streamed-body limits", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: PUBLIC_SPEC_URL },
      }),
    );
    await expect(invoke()).rejects.toThrow(/Failed to fetch spec/);
    expect(fetch).toHaveBeenCalledTimes(6);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_SPEC_IMPORT_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(invoke()).rejects.toThrow(/larger than 2MB/);
  });

  it("enforces one total network timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockImplementationOnce(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      );

      const promise = invoke().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_001);
      const error = await promise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Failed to fetch spec/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the total timeout to DNS resolution", async () => {
    vi.useFakeTimers();
    try {
      mocks.resolve4.mockImplementationOnce(
        async () => await new Promise<string[]>(() => undefined),
      );
      mocks.resolve6.mockImplementationOnce(
        async () => await new Promise<string[]>(() => undefined),
      );

      const promise = invoke("https://slow-dns.example/openapi.json").catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10_001);
      const error = await promise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Failed to fetch spec/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
