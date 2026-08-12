// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: {
      matches: Array<{ context: { userId: string } }>;
    }) => unknown;
  }) => select({ matches: [{ context: { userId: "user_test" } }] }),
  Link: ({
    children,
    to,
    className,
    onClick,
    "aria-label": ariaLabel,
    "aria-current": ariaCurrent,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    "aria-label"?: string;
    "aria-current"?: "page";
  }) => (
    <a
      href={to}
      className={className}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
    >
      {children}
    </a>
  ),
}));

vi.mock("#/components/theme-toggle", () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

import { PublicHeader } from "./public-header";

afterEach(cleanup);

describe("PublicHeader", () => {
  it("exposes a skip link and named primary navigation", () => {
    render(<PublicHeader active="catalogue" />);

    expect(
      screen
        .getByRole("link", { name: "Skip to content" })
        .getAttribute("href"),
    ).toBe("#main-content");
    expect(screen.getByRole("navigation")).not.toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Catalogue" }).length,
    ).toBeGreaterThan(0);
  });

  it("connects mobile disclosure state to its controlled navigation", () => {
    render(<PublicHeader />);
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(
      "public-mobile-navigation",
    );

    fireEvent.click(trigger);

    expect(
      screen
        .getByRole("button", { name: "Close navigation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const navigation = screen.getByRole("navigation", {
      name: "Public navigation",
    });
    expect(navigation.getAttribute("id")).toBe("public-mobile-navigation");
    expect(
      within(navigation).getByRole("link", { name: "Dashboard" }),
    ).not.toBeNull();
    expect(
      within(navigation).getByRole("link", { name: "GitHub" }),
    ).not.toBeNull();
  });

  it("exposes the current public destination to assistive technology", () => {
    render(<PublicHeader active="catalogue" />);

    for (const link of screen.getAllByRole("link", { name: "Catalogue" })) {
      expect(link.getAttribute("aria-current")).toBe("page");
    }
  });

  it("closes mobile navigation on Escape and restores trigger focus", () => {
    render(<PublicHeader />);
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(trigger);
    const catalogue = within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    ).getByRole("link", { name: "Catalogue" });
    catalogue.focus();
    expect(document.activeElement).toBe(catalogue);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("navigation", { name: "Public navigation" }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
