// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHydratedReducedMotion } from "#/hooks/use-hydrated-reduced-motion";
import { vtState } from "#/lib/vt";
import { FadeIn } from "./fade-in";
import { Magnetic } from "./magnetic";
import { NumberTicker } from "./number-ticker";

let media: EventTarget & { matches: boolean };
let now: number;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  now = 0;
  frames = new Map();
  let id = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  cleanup();
  vtState.active = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frame(time: number) {
  now = time;
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(time);
  });
}

function reduceMotion(reduced: boolean) {
  act(() => {
    media.matches = reduced;
    media.dispatchEvent(new Event("change"));
  });
}

describe("motion updates", () => {
  it("retargets a running ticker from its displayed value in either direction", () => {
    const view = render(<NumberTicker value={100} />);
    view.rerender(<NumberTicker value={200} />);
    frame(100);
    const intermediate = view.container.textContent;
    expect(intermediate).not.toBe("100");
    expect(intermediate).not.toBe("200");
    view.rerender(<NumberTicker value={50} />);
    frame(100);
    expect(view.container.textContent).toBe(intermediate);
    frame(700);
    expect(view.container.textContent).toBe("50");
    view.rerender(<NumberTicker value={250} />);
    frame(700);
    expect(view.container.textContent).toBe("50");
    frame(1300);
    expect(view.container.textContent).toBe("250");
  });

  it("stops a ticker immediately when the motion preference changes", () => {
    const view = render(<NumberTicker value={100} />);
    view.rerender(<NumberTicker value={200} />);
    frame(100);
    reduceMotion(true);
    expect(view.container.textContent).toBe("200");
    expect(frames.size).toBe(0);
    view.rerender(<NumberTicker value={75} />);
    expect(view.container.textContent).toBe("75");
    reduceMotion(false);
    view.rerender(<NumberTicker value={150} />);
    frame(700);
    expect(view.container.textContent).toBe("150");
  });

  it("renders ticker targets directly during navigation", () => {
    const view = render(<NumberTicker value={100} />);
    vtState.active = true;
    view.rerender(<NumberTicker value={200} />);
    expect(view.container.textContent).toBe("200");
    expect(frames.size).toBe(0);
  });

  it("keeps FadeIn server content visible without JavaScript", () => {
    const markup = renderToString(
      <LazyMotion features={domAnimation}>
        <FadeIn>Visible content</FadeIn>
      </LazyMotion>,
    );
    expect(markup).toContain("Visible content");
    expect(markup).not.toContain("opacity:0");
  });

  it("keeps magnetic children mounted when reduced motion changes", () => {
    const view = render(
      <LazyMotion features={domAnimation}>
        <Magnetic>
          <input defaultValue="keep me" />
        </Magnetic>
      </LazyMotion>,
    );
    const input = view.container.querySelector("input");
    reduceMotion(true);
    expect(view.container.querySelector("input")).toBe(input);
    reduceMotion(false);
    expect(view.container.querySelector("input")).toBe(input);
  });

  it("subscribes to preference changes and removes listeners on unmount", () => {
    const remove = vi.spyOn(media, "removeEventListener");
    function Preference() {
      return <span>{String(useHydratedReducedMotion())}</span>;
    }
    const view = render(<Preference />);
    expect(view.container.textContent).toBe("false");
    reduceMotion(true);
    expect(view.container.textContent).toBe("true");
    view.unmount();
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
