// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthCardSkeleton } from "#/components/auth-card-skeleton";

describe("AuthCardSkeleton", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels the initial loading state", () => {
    render(<AuthCardSkeleton label="Loading sign in" />);

    expect(
      screen.getByRole("status", { name: "Loading sign in" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers recovery when authentication stalls", () => {
    vi.useFakeTimers();
    render(<AuthCardSkeleton label="Loading account creation" />);

    act(() => vi.advanceTimersByTime(8_000));

    expect(
      screen.getByText("Authentication is taking longer than expected."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
