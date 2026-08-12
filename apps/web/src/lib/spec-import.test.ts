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
import { fetchSpecFromUrlServerBoundary } from "./spec-import.server";

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

describe("parseImportSpecUrl", () => {
  it("accepts http(s) urls", () => {
    expect(
      parseImportSpecUrl({ url: "https://example.com/openapi.json" }),
    ).toEqual({
      ok: true,
      data: { url: "https://example.com/openapi.json" },
    });
    expect(
      parseImportSpecUrl({ url: "  http://localhost:3000/spec.yaml  " }),
    ).toEqual({
      ok: true,
      data: { url: "http://localhost:3000/spec.yaml" },
    });
  });

  it("rejects non-http and junk", () => {
    expect(parseImportSpecUrl({ url: "ftp://example.com/x" }).ok).toBe(false);
    expect(parseImportSpecUrl({ url: "" }).ok).toBe(false);
    expect(parseImportSpecUrl({ url: "not-a-url" }).ok).toBe(false);
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
      /must be https/,
    );
    await expect(
      invoke("https://user:password@93.184.216.34/openapi.json"),
    ).rejects.toThrow(/Failed to fetch spec/);
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
    await expect(invoke()).rejects.toThrow(/return JSON or YAML/);

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

      const rejection =
        expect(invoke()).rejects.toThrow(/Failed to fetch spec/);
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
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

      const rejection = expect(
        invoke("https://slow-dns.example/openapi.json"),
      ).rejects.toThrow(/Failed to fetch spec/);
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
