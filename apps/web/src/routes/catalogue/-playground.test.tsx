// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useRouteContext: () => ({ userId: null }),
  }),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/sign-in">{children}</a>
  ),
}));
vi.mock("#/components/syntax-code", () => ({
  SyntaxCode: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

import { parsePublishedEndpoints } from "#/lib/openapi-reference";
import { TryItPanel } from "#/components/catalogue-detail";

const endpoints = parsePublishedEndpoints(
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Weather", version: "1.0.0" },
    servers: [{ url: "https://example.com" }],
    paths: {
      "/get": {
        get: {
          "x-zevium-cost": 1,
          responses: { "200": { description: "OK" } },
        },
      },
    },
  }),
);

function panel(rows = endpoints) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TryItPanel
        userId={null}
        publisherHandle="publisher"
        projectSlug="weather"
        endpoints={rows}
        endpointId={endpoints[0]!.id}
        mode="live"
        onEndpointChange={vi.fn()}
        onModeChange={vi.fn()}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it("disables the server-rendered form so secrets cannot enter a native GET submission", () => {
  const document = new DOMParser().parseFromString(
    renderToStaticMarkup(panel()),
    "text/html",
  );
  expect(document.querySelector("fieldset")?.disabled).toBe(true);
  expect(document.querySelector("#api-key")?.matches(":disabled")).toBe(true);
  expect(
    document.querySelector("button[type=submit]")?.matches(":disabled"),
  ).toBe(true);
  expect(document.querySelector("form")?.method).toBe("post");
});

it("enables the hydrated form and sends the key only as a gateway header", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const view = render(panel());
  const key = screen.getByLabelText<HTMLInputElement>("API key");
  expect(key.matches(":disabled")).toBe(false);
  fireEvent.change(key, { target: { value: "qa-placeholder-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Send live · 1 credit" }));
  await screen.findByText("200");
  // Quality refreshes can replace the endpoint objects without changing selection.
  view.rerender(panel(endpoints.map((endpoint) => ({ ...endpoint }))));
  expect(screen.getByText("200")).toBeTruthy();

  expect(fetch).toHaveBeenCalledWith(
    "http://localhost:8787/gateway/publisher/weather/get",
    expect.objectContaining({
      headers: { authorization: "Bearer qa-placeholder-key" },
    }),
  );
});

it("locks request inputs while the gateway response is pending", () => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  render(panel());
  const key = screen.getByLabelText<HTMLInputElement>("API key");
  fireEvent.change(key, { target: { value: "qa-placeholder-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Send live · 1 credit" }));
  expect(key.matches(":disabled")).toBe(true);
  expect(
    screen
      .getByRole("radio", { name: "Mock · 0 credits" })
      .matches(":disabled"),
  ).toBe(true);
});

const formEndpoints = parsePublishedEndpoints(
  JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/items/{id}": {
        post: {
          "x-zevium-cost": 2,
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "query",
              name: "limit",
              schema: { type: "integer", minimum: 1, maximum: 5, default: 2 },
            },
            {
              in: "header",
              name: "X-Region",
              schema: { type: "string", default: "eu" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string", minLength: 2 },
                    active: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/hidden": { get: { responses: { "200": { description: "OK" } } } },
      "/tokens": {
        post: {
          "x-zevium-cost": { per: "token", input: 1, output: 2 },
          responses: {},
        },
      },
    },
  }),
);
function generatedPanel(mode: "live" | "mock" = "mock") {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TryItPanel
        userId={null}
        publisherHandle="publisher"
        projectSlug="items"
        endpoints={formEndpoints}
        endpointId={formEndpoints[0]!.id}
        mode={mode}
        onEndpointChange={vi.fn()}
        onModeChange={vi.fn()}
      />
    </QueryClientProvider>
  );
}
it("blocks invalid fields, focuses their control, and never sends an invalid mock", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(generatedPanel());
  fireEvent.click(
    screen.getByRole("button", { name: "Send mock · 0 credits" }),
  );
  expect(fetch).not.toHaveBeenCalled();
  const id = screen.getByLabelText("id (path) · required");
  expect(document.activeElement).toBe(id);
  expect(id.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(id, { target: { value: "abc" } });
  fireEvent.change(screen.getByLabelText("limit (query)"), {
    target: { value: "9" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send mock · 0 credits" }),
  );
  expect(screen.getAllByText(/Must be at most 5/).length).toBeGreaterThan(0);
  const summary = screen
    .getAllByRole("listitem")
    .map((item) => item.textContent);
  expect(summary).toContain("limit (query): Must be at most 5.");
  expect(summary).toContain("Request body › title: This value is required.");
  expect(fetch).not.toHaveBeenCalled();
});
it("sends typed form values to keyless mock and previews identical curl/MCP request data", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  render(generatedPanel());
  expect(formEndpoints).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("id (path) · required"), {
    target: { value: "a/b" },
  });
  fireEvent.change(screen.getByLabelText("title · required"), {
    target: { value: "Example" },
  });
  const curl = screen.getByLabelText("curl preview").textContent!;
  expect(curl).toContain("/mock/publisher/items/items/a%2Fb?limit=2");
  expect(curl).toContain("x-region: eu");
  expect(curl).not.toContain("Authorization");
  fireEvent.click(
    screen.getByRole("button", { name: "Send mock · 0 credits" }),
  );
  await screen.findByText("200");
  const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
  expect(url).toBe(
    "http://localhost:8787/mock/publisher/items/items/a%2Fb?limit=2",
  );
  expect(init.headers).toEqual({
    "content-type": "application/json",
    "x-region": "eu",
  });
  expect(JSON.parse(init.body as string)).toEqual({
    title: "Example",
    active: false,
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "MCP call_api" }), {
    button: 0,
    ctrlKey: false,
  });
  const args = JSON.parse(
    screen.getByLabelText("MCP call_api arguments").textContent!,
  );
  expect(args).toEqual({
    org: "publisher",
    project: "items",
    method: "POST",
    path: "/items/a%2Fb?limit=2",
    headers: init.headers,
    body: JSON.parse(init.body as string),
  });
  expect(screen.getByText(/MCP has no mock mode/)).toBeTruthy();
});
it("validates raw JSON against the same schema and gates real calls on an API key", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(generatedPanel("live"));
  fireEvent.change(screen.getByLabelText("id (path) · required"), {
    target: { value: "abc" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Raw JSON" }));
  fireEvent.change(screen.getByLabelText("Request body JSON"), {
    target: { value: '{"title":3}' },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send live · 2 credits" }),
  );
  expect(
    screen.getByText(/Request body › title: Enter string value/),
  ).toBeTruthy();
  expect(screen.getAllByText(/API key is required/).length).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("reports an invalid key without leaking it or throwing from header construction", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(panel());
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "invalid-\u2603-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send live · 1 credit" }));
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getAllByText(/Enter a valid API key/).length).toBeGreaterThan(
    0,
  );
  expect(screen.getByLabelText("curl preview").textContent).not.toContain(
    "invalid-",
  );
});
