import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_SPEC_IMPORT_BYTES, parseImportSpecUrl } from "./spec-import";
import {
  fetchSpecFromUrlForRequest,
  type SpecImportRuntime,
} from "./spec-import.server";

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
    Response.json(
      { openapi: "3.1.0" },
      {
        headers: { "content-type": "application/json" },
      },
    ),
  );
  const runtime: SpecImportRuntime = {
    authenticate,
    resolveHostname,
    fetch,
  };
  return { runtime, authenticate, resolveHostname, fetch };
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
      text: JSON.stringify({ openapi: "3.1.0" }),
      contentType: "application/json",
    });
    expect(fixture.authenticate).toHaveBeenCalledOnce();
    expect(fixture.resolveHostname).toHaveBeenCalledWith("example.com");
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.authenticate.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.resolveHostname.mock.invocationCallOrder[0],
    );
    expect(fixture.resolveHostname.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.fetch.mock.invocationCallOrder[0],
    );
    const [, init] = fixture.fetch.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
          { status: 302, headers: { location: "https://cdn.example/spec" } },
          cancel,
        ),
      )
      .mockResolvedValueOnce(new Response("openapi: 3.1.0", { status: 200 }));

    const result = await fetchSpecFromUrlForRequest(
      { url: "https://example.com/openapi.json" },
      fixture.runtime,
    );

    expect(result.text).toBe("openapi: 3.1.0");
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
    const rejection = expect(pending).rejects.toThrow("Failed to fetch spec");
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(observedAbort).toHaveBeenCalledOnce();
  });
});
