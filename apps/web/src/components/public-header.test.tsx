// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/tanstack-react-start", () => ({
  Show: ({ children }: { children: React.ReactNode }) => children,
  UserButton: () => <button type="button">User menu</button>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    className,
    onClick,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    "aria-label"?: string;
  }) => (
    <a href={to} className={className} onClick={onClick} aria-label={ariaLabel}>
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
    expect(
      screen
        .getByRole("navigation", { name: "Public navigation" })
        .getAttribute("id"),
    ).toBe("public-mobile-navigation");
  });
});
