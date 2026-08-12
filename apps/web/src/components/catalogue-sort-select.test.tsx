// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogueSortSelect } from "./catalogue-sort-select";

afterEach(cleanup);

describe("CatalogueSortSelect", () => {
  it("shows its default value in a named combobox", () => {
    render(<CatalogueSortSelect value="newest" onValueChange={vi.fn()} />);

    const select = screen.getByRole("combobox", { name: "Sort catalogue" });
    expect(select.textContent).toContain("Newest");
    expect(select.getAttribute("data-placeholder")).toBeNull();
  });

  it("shows every controlled value instead of an empty trigger", () => {
    const { rerender } = render(
      <CatalogueSortSelect value="name" onValueChange={vi.fn()} />,
    );

    expect(
      screen.getByRole("combobox", { name: "Sort catalogue" }).textContent,
    ).toContain("Name");

    rerender(<CatalogueSortSelect value="cheapest" onValueChange={vi.fn()} />);
    expect(
      screen.getByRole("combobox", { name: "Sort catalogue" }).textContent,
    ).toContain("Cheapest");
  });
});
