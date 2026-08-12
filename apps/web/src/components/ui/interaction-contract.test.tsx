// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetTitle } from "./sheet";

afterEach(cleanup);

describe("overlay interaction contract", () => {
  it("keeps stock dialog and sheet close semantics addressable by global CSS", () => {
    render(
      <>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Dialog fixture</DialogTitle>
          </DialogContent>
        </Dialog>
        <Sheet open>
          <SheetContent>
            <SheetTitle>Sheet fixture</SheetTitle>
          </SheetContent>
        </Sheet>
      </>,
    );

    const closeButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-slot="dialog-close"], [data-slot="sheet-close"]',
      ),
    );
    expect(closeButtons).toHaveLength(2);
    expect(closeButtons.every((button) => button.textContent === "Close")).toBe(
      true,
    );
    expect(closeButtons.map((button) => button.dataset.slot)).toEqual([
      "dialog-close",
      "sheet-close",
    ]);
  });

  it("globally kills CSS and view-transition motion when requested", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));

    expect(reduced).toContain("transition-duration: 0s !important");
    expect(reduced).toContain("animation-duration: 0s !important");
    expect(reduced).toContain("::view-transition-image-pair(*)");
    expect(reduced).toContain("::view-transition-old(*)");
    expect(reduced).toContain("::view-transition-new(*)");
  });

  it("expands controls only for coarse pointers", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));

    expect(coarse).toContain("min-block-size: 2.75rem");
    expect(coarse).toContain("min-inline-size: 2.75rem");
    expect(coarse).toContain(
      ':where([data-slot="checkbox"], [data-slot="switch"])::after',
    );
    expect(css.slice(0, css.indexOf("@media (pointer: coarse)"))).not.toContain(
      "min-block-size: 2.75rem",
    );
  });
});
