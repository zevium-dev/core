// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDebouncedUrlDraft } from "./catalogue-search";

function DraftHarness({
  committed,
  onCommit,
}: {
  committed: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useDebouncedUrlDraft(committed, onCommit, 250);
  return (
    <input
      aria-label="Catalogue query"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDebouncedUrlDraft", () => {
  it("does not commit URL state for every keystroke", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    render(<DraftHarness committed="" onCommit={commit} />);

    const input = screen.getByRole("textbox", { name: "Catalogue query" });
    fireEvent.change(input, { target: { value: "w" } });
    fireEvent.change(input, { target: { value: "we" } });
    fireEvent.change(input, { target: { value: "weather" } });

    act(() => vi.advanceTimersByTime(249));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("weather");
  });

  it("lets back-forward state cancel a stale pending draft", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const view = render(<DraftHarness committed="first" onCommit={commit} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Catalogue query" }), {
      target: { value: "stale local edit" },
    });
    view.rerender(<DraftHarness committed="back" onCommit={commit} />);

    expect(
      (
        screen.getByRole("textbox", {
          name: "Catalogue query",
        }) as HTMLInputElement
      ).value,
    ).toBe("back");
    act(() => vi.advanceTimersByTime(500));
    expect(commit).not.toHaveBeenCalled();
  });
});
