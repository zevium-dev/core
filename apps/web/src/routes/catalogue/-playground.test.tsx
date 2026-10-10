// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

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
  );
}

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
      headers: { Authorization: "Bearer qa-placeholder-key" },
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
