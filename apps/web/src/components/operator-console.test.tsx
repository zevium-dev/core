// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const state = vi.hoisted(() => ({
  run: vi.fn(),
  queries: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: state.error, success: state.success },
}));
vi.mock("convex/react", () => ({
  useAction: () => state.run,
  useMutation: () => state.run,
  usePaginatedQuery: (
    reference: Parameters<typeof getFunctionName>[0],
    args: unknown,
  ) => {
    const name = getFunctionName(reference);
    state.queries(name, args);
    return {
      status: "Exhausted",
      loadMore: vi.fn(),
      results:
        name === "admin:listFinanceReconciliationCases"
          ? [
              {
                rowKind: "case",
                _id: "case-id",
                kind: "settlement_exception",
                status: "open",
                reason: "Missing source",
                updatedAt: 1,
                transferAmountCents: null,
              },
            ]
          : [],
    };
  },
}));
import { OperatorConsole } from "./operator-console";
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.run.mockResolvedValue({ status: "resolved" });
});
async function expandCase() {
  const summary = screen.getByText(/settlement_exception · open/);
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByLabelText("Audit note");
  fireEvent.change(screen.getByLabelText("Audit note"), {
    target: { value: "Checked source and served usage" },
  });
}
it("defaults to open cases and subscribes to evidence only when expanded", async () => {
  render(<OperatorConsole />, { wrapper: Providers });
  expect(state.queries).toHaveBeenCalledWith(
    "admin:listFinanceReconciliationCases",
    { status: "open" },
  );
  expect(
    state.queries.mock.calls.some(([name]) => name === "operators:evidence"),
  ).toBe(false);
  await expandCase();
  expect(state.queries).toHaveBeenCalledWith("operators:evidence", {
    caseId: "case-id",
  });
});
it("requires confirmation containing case, amount, effect and note before voiding", async () => {
  render(<OperatorConsole />, { wrapper: Providers });
  await expandCase();
  fireEvent.click(screen.getByRole("button", { name: "Void exception" }));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(screen.getByText("case-id")).toBeTruthy();
  expect(screen.getByText("0 credits moved")).toBeTruthy();
  expect(screen.getByText(/Permanently records this exception/)).toBeTruthy();
  expect(
    screen.getByText("Checked source and served usage", { selector: "dd" }),
  ).toBeTruthy();
  expect(state.run).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm void exception" }),
  );
  await waitFor(() =>
    expect(state.run).toHaveBeenCalledWith({
      caseId: "case-id",
      disposition: "void",
      resolution: "Checked source and served usage",
    }),
  );
});
it("shows curated ConvexError and treats exception recovery as non-success", async () => {
  render(<OperatorConsole />, { wrapper: Providers });
  await expandCase();
  state.run.mockRejectedValueOnce(
    new ConvexError("Case changed; review it again"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
  await waitFor(() =>
    expect(state.error).toHaveBeenCalledWith("Case changed; review it again"),
  );
  state.run.mockResolvedValueOnce({ status: "exception" });
  fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
  await waitFor(() => expect(state.error).toHaveBeenCalledTimes(2));
  expect(state.success).not.toHaveBeenCalled();
});
