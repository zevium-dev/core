// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRoute,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_EMAIL } from "#/lib/contact";
import { Route as Privacy } from "#/routes/privacy";
import { Route as Support } from "#/routes/support";
import { Route as Terms } from "#/routes/terms";

vi.mock("#/components/theme-toggle", () => ({ ThemeToggle: () => null }));

let media: EventTarget & { matches: boolean };

beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderPage(path: string, source: AnyRoute) {
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path,
    component: source.options.component,
    head: source.options.head,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

const PAGES = [
  ["/privacy", Privacy, "Privacy Policy"],
  ["/terms", Terms, "Terms of Service"],
  ["/support", Support, "Support"],
] as const;

describe("work-in-progress public pages", () => {
  it.each(PAGES)(
    "%s renders one main landmark, heading, contact and footer links",
    async (path, source, heading) => {
      const router = await renderPage(path, source);
      const main = await screen.findByRole("main");
      expect(screen.getAllByRole("main")).toHaveLength(1);
      expect(main.id).toBe("main-content");
      expect(
        within(main).getByRole("heading", { level: 1, name: heading }),
      ).toBeTruthy();
      expect(within(main).getByText("In progress")).toBeTruthy();

      const mail = within(main).getByRole("link", {
        name: (name) => name.includes(SUPPORT_EMAIL),
      });
      expect(mail.getAttribute("href")).toBe(`mailto:${SUPPORT_EMAIL}`);

      const art = main.querySelector("svg.wip-art");
      expect(art?.getAttribute("aria-hidden")).toBe("true");
      expect(art?.hasAttribute("data-static")).toBe(false);

      const footer = within(
        screen.getByRole("navigation", { name: "Footer navigation" }),
      );
      for (const [name, href] of [
        ["Privacy", "/privacy"],
        ["Terms", "/terms"],
        ["Support", "/support"],
      ]) {
        expect(footer.getByRole("link", { name }).getAttribute("href")).toBe(
          href,
        );
      }

      const title = router.state.matches
        .flatMap((match) => match.meta ?? [])
        .find((meta) => meta?.title)?.title;
      expect(title).toBe(`${heading} · Zevium`);
    },
  );

  it("shows the finished illustration when reduced motion is preferred", async () => {
    media.matches = true;
    await renderPage("/terms", Terms);
    const main = await screen.findByRole("main");
    expect(main.querySelector("svg.wip-art")?.hasAttribute("data-static")).toBe(
      true,
    );

    act(() => {
      media.matches = false;
      media.dispatchEvent(new Event("change"));
    });
    expect(main.querySelector("svg.wip-art")?.hasAttribute("data-static")).toBe(
      false,
    );
  });
});
