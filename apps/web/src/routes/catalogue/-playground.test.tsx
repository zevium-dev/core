// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { generateSpecContract, generatedToolArguments } from "@zevium/shared";
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

function panel(rows = endpoints, endpointId = rows[0]!.id) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TryItPanel
        userId={null}
        publisherHandle="publisher"
        projectSlug="weather"
        endpoints={rows}
        endpointId={endpointId}
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
  fireEvent.mouseDown(screen.getByRole("tab", { name: "MCP" }), {
    button: 0,
    ctrlKey: false,
  });
  const args = JSON.parse(
    screen.getByLabelText("MCP tool arguments").textContent!,
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
  expect(screen.getByText("call_api_write")).toBeTruthy();
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

function bodySpec(schema: unknown, example: unknown) {
  return JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/body": {
        post: {
          "x-zevium-cost": 1,
          requestBody: {
            required: true,
            content: { "application/json": { schema, example } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });
}
function bodyEndpoints(schema: unknown, example: unknown) {
  return parsePublishedEndpoints(bodySpec(schema, example));
}

it.each(
  ["hello", null, false, 0, { message: "hello" }, [1, 2]].map((value) => ({
    value,
  })),
)(
  "preserves JSON body $value in MCP preview and gateway bytes",
  async ({ value }) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    render(panel(bodyEndpoints({}, value)));
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "qa-placeholder-key" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send live · 1 credit" }),
    );
    await screen.findByText("200");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "MCP" }), {
      button: 0,
      ctrlKey: false,
    });
    const args = JSON.parse(
      screen.getByLabelText("MCP tool arguments").textContent!,
    );
    const operation = generateSpecContract({
      spec: bodySpec({}, value),
      version: "1.0.0",
    }).operations[0]!;
    expect(args.body).toEqual(
      generatedToolArguments(operation, "publisher", "weather", { body: value })
        .body,
    );
    // The gateway adapter sends strings verbatim and treats null/undefined as absent.
    const adapted =
      args.body === null || args.body === undefined
        ? undefined
        : typeof args.body === "string"
          ? args.body
          : JSON.stringify(args.body);
    const sent = fetch.mock.calls[0]![1].body as string;
    if (typeof args.body === "string") expect(adapted).toBe(sent);
    else expect(JSON.parse(adapted!)).toEqual(JSON.parse(sent));
  },
);
it.each([
  [
    { type: "array", minItems: 1, items: { type: "string" } },
    [],
    "Use at least 1 items.",
  ],
  [
    {
      type: "object",
      minProperties: 1,
      properties: { name: { type: "string" } },
    },
    {},
    "Use at least 1 properties.",
  ],
])(
  "focuses and announces container validation errors for %j",
  (schema, example, message) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(panel(bodyEndpoints(schema, example)));
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "qa-placeholder-key" },
    });
    const send = screen.getByRole("button", { name: "Send live · 1 credit" });
    send.focus();
    fireEvent.click(send);
    expect(fetch).not.toHaveBeenCalled();
    const target = document.activeElement!;
    expect(target.getAttribute("data-form-path")).toBe("body");
    expect(target.getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(
      target.getAttribute("aria-describedby")!,
    );
    expect(error?.textContent).toBe(message);
    expect(error?.getAttribute("role")).toBe("alert");
  },
);

it("renders a parameter example behind 18 nested allOf schemas without amplifying warnings", () => {
  let schema: unknown = { pattern: "x" };
  for (let i = 0; i < 18; i++) schema = { allOf: [schema] };
  const rows = parsePublishedEndpoints(
    JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/nested": {
          get: {
            "x-zevium-cost": 1,
            parameters: [{ in: "query", name: "value", example: "x", schema }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    }),
  );
  render(panel(rows));
  expect(
    screen.getByLabelText<HTMLTextAreaElement>("value (query)").value,
  ).toBe('"x"');
  expect(
    screen.getAllByText(
      "Validation is incomplete: value: Not checked here: pattern.",
    ),
  ).toHaveLength(1);
});

it("hydrates stored API keys without including them in server markup", () => {
  sessionStorage.setItem("zevium:playground-api-key", "qa-stored-key");
  expect(renderToStaticMarkup(panel())).not.toContain("qa-stored-key");
  render(panel());
  const key = screen.getByLabelText<HTMLInputElement>("API key");
  expect(key.value).toBe("qa-stored-key");
  fireEvent.change(key, { target: { value: "" } });
  expect(key.value).toBe("");
  expect(sessionStorage.getItem("zevium:playground-api-key")).toBeNull();
});

it("resets typed parameters and body when the selected endpoint changes", () => {
  const first = formEndpoints[0]!;
  const second = { ...first, id: "POST /other/{id}", path: "/other/{id}" };
  const rows = [first, second];
  const view = render(panel(rows, first.id));
  fireEvent.change(screen.getByLabelText("id (path) · required"), {
    target: { value: "edited-id" },
  });
  fireEvent.change(screen.getByLabelText("title · required"), {
    target: { value: "Edited title" },
  });
  view.rerender(panel(rows, second.id));
  expect(
    screen.getByLabelText<HTMLInputElement>("id (path) · required").value,
  ).toBe("");
  expect(
    screen.getByLabelText<HTMLInputElement>("title · required").value,
  ).toBe("");
  expect(screen.getByLabelText<HTMLInputElement>("limit (query)").value).toBe(
    "2",
  );
});
