// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { listSpecEndpoints } from "#/lib/spec-endpoints";
import { applyPricingEdit } from "#/lib/spec-pricing-edit";
import { SpecRailEndpoints } from "./rail-endpoints";

const initial = JSON.stringify({
  openapi: "3.1.0",
  paths: {
    "/ping": { get: { "x-zevium-cost": 7, "x-zevium-free-tier": 2 } },
    "/other": { post: { "x-zevium-cost": 3 } },
  },
});

function DraftRail() {
  const [text, setText] = useState(initial);
  const endpoints = listSpecEndpoints(text);
  return (
    <>
      <output data-testid="draft">{text}</output>
      <SpecRailEndpoints
        endpoints={endpoints ?? []}
        stale={endpoints === null}
        disabled={endpoints === null}
        onPricingChange={(edit) => {
          const result = applyPricingEdit(text, edit);
          if (result.ok) setText(result.text);
        }}
      />
    </>
  );
}

afterEach(cleanup);
describe("inline pricing correction", () => {
  it.each(["-1", "1.5", "1000001", "9007199254740992", "Infinity", "oops"])(
    "keeps rejected %s editable through blur without corrupting the draft",
    (value) => {
      render(<DraftRail />);
      const cost =
        screen.getByLabelText<HTMLInputElement>("Cost for GET /ping");
      fireEvent.change(cost, { target: { value } });
      fireEvent.blur(cost);
      expect(cost.value).toBe(value);
      expect(cost.disabled).toBe(false);
      expect(cost.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toContain(
        "Enter a whole number from 0 to 1,000,000.",
      );
      expect(cost.getAttribute("aria-describedby")).toBe(
        screen.getByRole("alert").id,
      );
      expect(screen.getByTestId("draft").textContent).toBe(initial);
      for (const input of screen.getAllByRole<HTMLInputElement>("textbox"))
        expect(input.disabled).toBe(false);
      fireEvent.change(cost, { target: { value: "7" } });
      fireEvent.blur(cost);
      expect(cost.value).toBe("7");
      expect(cost.getAttribute("aria-invalid")).toBe("false");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(JSON.parse(screen.getByTestId("draft").textContent!)).toEqual(
        JSON.parse(initial),
      );
    },
  );

  it("keeps a cleared price hidden through invalid input and accepts explicit zero", () => {
    render(<DraftRail />);
    const cost = screen.getByLabelText<HTMLInputElement>("Cost for GET /ping");
    fireEvent.change(cost, { target: { value: "" } });
    fireEvent.blur(cost);
    expect(cost.value).toBe("");
    expect(
      screen.getByText("Hidden until priced. Set 0 for free."),
    ).toBeTruthy();
    const unpricedDraft = screen.getByTestId("draft").textContent!;
    expect(
      JSON.parse(unpricedDraft).paths["/ping"].get["x-zevium-cost"],
    ).toBeUndefined();
    fireEvent.change(cost, { target: { value: "-1" } });
    fireEvent.blur(cost);
    expect(cost.value).toBe("-1");
    expect(cost.disabled).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("draft").textContent).toBe(unpricedDraft);
    fireEvent.change(cost, { target: { value: "0" } });
    fireEvent.blur(cost);
    expect(cost.value).toBe("0");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("Hidden until priced. Set 0 for free."),
    ).toBeNull();
    expect(
      JSON.parse(screen.getByTestId("draft").textContent!).paths["/ping"].get[
        "x-zevium-cost"
      ],
    ).toBe(0);
  });

  it("corrects an invalid free tier and accepts zero, clearing, and the upper bound", () => {
    render(<DraftRail />);
    const free = screen.getByLabelText<HTMLInputElement>(
      "Free tier for GET /ping",
    );
    fireEvent.change(free, { target: { value: "-1" } });
    fireEvent.blur(free);
    expect(free.disabled).toBe(false);
    expect(screen.getByRole("alert")).toBeDefined();
    for (const value of ["0", "1000000", ""]) {
      fireEvent.change(free, { target: { value } });
      fireEvent.blur(free);
      expect(screen.queryByRole("alert")).toBeNull();
      const draft = JSON.parse(screen.getByTestId("draft").textContent!);
      expect(draft.paths["/ping"].get["x-zevium-free-tier"]).toBe(
        value === "" ? undefined : Number(value),
      );
      expect(draft.paths["/ping"].get["x-zevium-cost"]).toBe(7);
    }
  });
});
