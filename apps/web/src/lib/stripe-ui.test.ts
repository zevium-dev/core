import { describe, expect, it } from "vitest";

import {
  checkoutDisplay,
  checkoutPackButton,
  checkoutStartFailureMessage,
  checkoutStateFromStatus,
  connectedAccountDisplay,
  earningStatusLabel,
  earningTotalsByStatus,
  moneyMovementFailure,
  moneyMovementStatusLabel,
  operatorTransferAction,
  paymentStatusLabel,
} from "./stripe-ui";

describe("checkoutDisplay", () => {
  it("renders the hosted Checkout return as processing without a client grant", () => {
    expect(checkoutDisplay("processing")).toEqual({
      title: "Confirming payment",
      description:
        "We are waiting for Stripe to confirm this payment. Credits are not added from this page.",
      variant: "outline",
    });
  });

  it("renders Stripe-confirmed and failed payment states distinctly", () => {
    expect(checkoutDisplay("succeeded").title).toBe("Payment confirmed");
    expect(checkoutDisplay("failed")).toMatchObject({
      title: "Payment was not completed",
      variant: "destructive",
    });
  });

  it("treats unknown redirect status as processing rather than a client-side grant", () => {
    expect(checkoutStateFromStatus("paid")).toBe("succeeded");
    expect(checkoutStateFromStatus("complete")).toBe("succeeded");
    expect(checkoutStateFromStatus("payment_failed")).toBe("failed");
    expect(checkoutStateFromStatus("created")).toBe("processing");
  });

  it("labels realtime payment history safely", () => {
    expect(paymentStatusLabel("pending")).toBe("Processing");
    expect(paymentStatusLabel("succeeded")).toBe("Paid");
    expect(paymentStatusLabel("failed")).toBe("Failed");
    expect(paymentStatusLabel("refunded")).toBe("Refunded");
    expect(paymentStatusLabel("disputed")).toBe("Disputed");
    expect(paymentStatusLabel("dispute_won")).toBe("Dispute won");
    expect(paymentStatusLabel("dispute_lost")).toBe("Dispute lost");
  });

  it("disables duplicate pack selection while one hosted Checkout redirect starts", () => {
    expect(checkoutPackButton("pack_10", "pack_10", true, "$10")).toEqual({
      disabled: true,
      label: "Redirecting to Stripe…",
    });
    expect(checkoutPackButton("pack_50", "pack_10", true, "$50")).toEqual({
      disabled: true,
      label: "Buy $50",
    });
  });

  it("uses a safe checkout-start error when no server message is available", () => {
    expect(checkoutStartFailureMessage()).toBe(
      "Could not start secure checkout.",
    );
    expect(checkoutStartFailureMessage("  Checkout unavailable  ")).toBe(
      "Checkout unavailable",
    );
  });
});

describe("connectedAccountDisplay", () => {
  it("provides a safe remediation action for every Connect state", () => {
    expect(connectedAccountDisplay("not_started")).toMatchObject({
      action: "start",
      actionLabel: "Start Stripe onboarding",
    });
    expect(
      connectedAccountDisplay("incomplete", undefined, ["identity"]),
    ).toMatchObject({
      action: "continue",
      actionLabel: "Continue onboarding",
      description: expect.stringContaining("identity"),
    });
    expect(
      connectedAccountDisplay("restricted", "Payouts are paused", [
        "bank account",
      ]),
    ).toMatchObject({
      action: "fix",
      variant: "destructive",
      description: expect.stringContaining("Payouts are paused"),
    });
    expect(connectedAccountDisplay("enabled")).toMatchObject({
      action: null,
      variant: "secondary",
    });
  });
});

describe("publisher earning lifecycle", () => {
  it("labels every externally visible lifecycle state", () => {
    expect(earningStatusLabel("pending_risk")).toBe("Pending risk review");
    expect(earningStatusLabel("available")).toBe("Available");
    expect(earningStatusLabel("allocated_to_transfer")).toBe(
      "Transfer in progress",
    );
    expect(earningStatusLabel("transferred")).toBe("Transferred to Stripe");
    expect(earningStatusLabel("paid")).toBe("Paid to bank");
    expect(earningStatusLabel("reversed")).toBe("Reversed");
    expect(earningStatusLabel("failed")).toBe("Transfer failed");
  });

  it("totals pending, available, transferred, paid, and reversed values", () => {
    expect(
      earningTotalsByStatus([
        { status: "pending_risk", netCredits: 10 },
        { status: "allocated_to_transfer", netCredits: 20 },
        { status: "failed", netCredits: 30 },
        { status: "available", netCredits: 40 },
        { status: "transferred", netCredits: 50 },
        { status: "paid", netCredits: 60 },
        { status: "reversed", netCredits: 70 },
      ]),
    ).toEqual({
      pending: 60,
      available: 40,
      transferred: 50,
      paid: 60,
      reversed: 70,
    });
  });
});

describe("money movement failures", () => {
  it("surfaces safe transfer and payout failure text only for failures", () => {
    expect(
      moneyMovementFailure("failed", "Recipient account is unavailable"),
    ).toBe("Recipient account is unavailable");
    expect(moneyMovementFailure("failed")).toContain("retried safely");
    expect(moneyMovementFailure("paid", "ignored")).toBeNull();
  });

  it("labels transfer and bank payout states", () => {
    expect(moneyMovementStatusLabel("created")).toBe("Created");
    expect(moneyMovementStatusLabel("pending")).toBe("Queued");
    expect(moneyMovementStatusLabel("transferred")).toBe("Transferred");
    expect(moneyMovementStatusLabel("paid")).toBe("Paid");
    expect(moneyMovementStatusLabel("failed")).toBe("Failed");
    expect(moneyMovementStatusLabel("canceled")).toBe("Canceled");
  });

  it("allows an operator to retry only a failed transfer", () => {
    expect(operatorTransferAction("processing")).toEqual({
      action: null,
      label: null,
      confirmation: null,
    });
    expect(operatorTransferAction("failed")).toEqual({
      action: "retry",
      label: "Retry transfer",
      confirmation:
        "Retry this failed Stripe transfer? The server will reuse its idempotency key.",
    });
  });
});
