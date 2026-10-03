import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureViewTransitions, runViewTransition, vtState } from "./vt";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let reduced = false;
let typed = true;
let dataset: Record<string, string>;
let completions: ReturnType<typeof deferred>[];
let start: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reduced = false;
  typed = true;
  dataset = {};
  completions = [];
  start = vi.fn(
    (options: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
      const update = typeof options === "function" ? options : options.update!;
      const finished = deferred();
      completions.push(finished);
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve().then(update),
        finished: finished.promise,
      };
    },
  );
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: reduced }),
    CSS: { supports: () => typed },
  });
  vi.stubGlobal("document", {
    documentElement: { dataset },
    startViewTransition: start,
  });
  vi.stubGlobal("self", {});
});

afterEach(async () => {
  for (const completion of completions) completion.resolve();
  await Promise.resolve();
  vi.unstubAllGlobals();
});

describe("native transition lifecycle", () => {
  it("keeps entrances suppressed until the animation finishes, independently of update completion", async () => {
    const update = deferred();
    const task = runViewTransition(() => update.promise, ["navigate-forward"]);
    expect(vtState.active).toBe(true);
    expect(dataset.viewTransition).toBe("active");
    expect(dataset.viewTransitionKind).toBe("morph");
    update.resolve();
    await task;
    expect(vtState.active).toBe(true);
    completions[0].resolve();
    await Promise.resolve();
    expect(vtState.active).toBe(false);
    expect(dataset.viewTransition).toBeUndefined();
    expect(dataset.viewTransitionKind).toBeUndefined();
  });

  it("does not let an older skipped transition clear a newer transition", async () => {
    await runViewTransition(async () => undefined, ["navigate-forward"]);
    await runViewTransition(async () => undefined, ["navigate-back"]);
    completions[0].resolve();
    await Promise.resolve();
    expect(vtState.active).toBe(true);
    completions[1].resolve();
    await Promise.resolve();
    expect(vtState.active).toBe(false);
  });

  it("cleans up failed updates and propagates the update failure", async () => {
    const error = new Error("update failed");
    await expect(
      runViewTransition(async () => {
        throw error;
      }, []),
    ).rejects.toBe(error);
    completions[0].reject(error);
    await Promise.resolve();
    expect(vtState.active).toBe(false);
  });

  it("falls back to an ordinary update when native startup fails", async () => {
    start.mockImplementationOnce(() => {
      throw new Error("unsupported");
    });
    const update = vi.fn(async () => undefined);
    await runViewTransition(update, []);
    expect(update).toHaveBeenCalledOnce();
    expect(vtState.active).toBe(false);
  });

  it("coordinates untyped browsers too", async () => {
    typed = false;
    const update = vi.fn(async () => undefined);
    await runViewTransition(update, ["navigate-back"]);
    expect(start).toHaveBeenCalledWith(update);
    expect(vtState.active).toBe(true);
  });

  it.each([true, false])(
    "exposes the page-swap policy until finished (type support: %s)",
    async (supportsTypes) => {
      typed = supportsTypes;
      await runViewTransition(
        async () => undefined,
        ["navigate-back", "nav-swap"],
      );
      expect(dataset.viewTransitionKind).toBe("swap");
      completions[0].resolve();
      await Promise.resolve();
      expect(dataset.viewTransitionKind).toBeUndefined();
    },
  );

  it.each([true, false])(
    "skips all native motion when reduced motion is enabled (type support: %s)",
    async (supportsTypes) => {
      reduced = true;
      typed = supportsTypes;
      const update = vi.fn(async () => undefined);
      await runViewTransition(update, ["navigate-forward"]);
      expect(start).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledOnce();
    },
  );

  it("still navigates without browser support", async () => {
    vi.stubGlobal("document", {});
    const update = vi.fn(async () => undefined);
    await runViewTransition(update, []);
    expect(update).toHaveBeenCalledOnce();
  });
});

describe("router integration", () => {
  it("evaluates types in untyped browsers and honors per-navigation opt-out", async () => {
    typed = false;
    const types = vi.fn(() => false as const);
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory(),
      defaultViewTransition: { types },
    });
    configureViewTransitions(router);
    const update = vi.fn(async () => undefined);
    await router.startViewTransition(update);
    expect(types).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    router.shouldViewTransition = true;
    await router.startViewTransition(update);
    expect(start).toHaveBeenCalledOnce();
    expect(router.shouldViewTransition).toBeUndefined();
    router.shouldViewTransition = false;
    await router.startViewTransition(update);
    expect(start).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(3);
  });
});
