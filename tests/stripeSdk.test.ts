import { afterEach, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { api } from "../convex/_generated/api";
import { definitiveStripeFailure } from "../convex/lib/stripe";
import { harness, identity } from "./helpers";
import { NOW, organization } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps Dahlia headers and recipient-scoped Accounts v2 onboarding on SDK v23", async () => {
  vi.stubEnv("NEXT_STRIPE_SECRET_KEY", ["sk", "test", "fixture"].join("_"));
  vi.stubEnv("NEXT_STRIPE_PLATFORM_ACCOUNT_ID", "acct_platform");
  vi.stubEnv("NEXT_APP_ORIGIN", "https://app.example.com");
  const t = harness();
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      ...organization("sdk"),
      connect: {
        accountId: "acct_recipient",
        platformAccountId: "acct_platform",
        livemode: false,
        status: "active",
        requirements: [],
        updatedAt: NOW,
      },
      connectOperation: {
        id: "sdk-operation",
        kind: "account",
        country: "US",
        contactEmail: "fixture@example.com",
        displayName: "SDK fixture",
        platformAccountId: "acct_platform",
        startedAt: NOW,
        state: "complete",
        nextAttemptAt: NOW,
        requestFingerprint: "fixture-fingerprint",
      },
    }),
  );
  const requests: { path: string; headers: Headers; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        headers: request.headers,
        body: await request.text(),
      });
      switch (path) {
        case "/v1/account":
          return Response.json({
            id: "acct_platform",
            default_currency: "usd",
          });
        case "/v1/balance":
          return Response.json({ livemode: false });
        case "/v2/core/account_links":
          return Response.json({
            account: "acct_recipient",
            livemode: false,
            url: "https://connect.stripe.com/fixture-onboarding",
          });
        default:
          throw new Error(`Unexpected Stripe request: ${path}`);
      }
    }),
  );
  const result = await t
    .withIdentity(identity("sdk"))
    .action(api.payouts.startOnboarding, {});
  expect(result.url).toBe("https://connect.stripe.com/fixture-onboarding");
  expect(requests.map((request) => request.path).sort()).toEqual([
    "/v1/account",
    "/v1/balance",
    "/v2/core/account_links",
  ]);
  for (const request of requests) {
    expect(request.headers.get("stripe-version")).toBe("2026-06-24.dahlia");
  }
  const linkRequest = requests.find(
    (request) => request.path === "/v2/core/account_links",
  )!;
  expect(JSON.parse(linkRequest.body)).toEqual({
    account: "acct_recipient",
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["recipient"],
        refresh_url: "https://app.example.com/app/earnings",
        return_url: "https://app.example.com/app/earnings",
      },
    },
  });
  const org = await t.run((ctx) => ctx.db.get(orgId));
  expect(org?.connectOperation?.link?.state).toBe("complete");
  expect(linkRequest.headers.get("idempotency-key")).toBe(
    `next:link:${orgId}:${org?.connectOperation?.link?.id}`,
  );
});

it("retains allocations for both API and incomplete-body connection failures", () => {
  expect(
    definitiveStripeFailure(
      new Stripe.errors.StripeAPIError({ message: "ambiguous" }),
    ),
  ).toBe(false);
  expect(
    definitiveStripeFailure(
      new Stripe.errors.StripeConnectionError({ message: "incomplete body" }),
    ),
  ).toBe(false);
  expect(
    definitiveStripeFailure(
      new Stripe.errors.StripeInvalidRequestError({
        message: "invalid request",
      }),
    ),
  ).toBe(true);
});
