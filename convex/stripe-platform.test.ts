import Stripe from "stripe";
import { afterEach, expect, it, vi } from "vitest";
import { assertStripePlatformIdentity } from "./lib/stripePlatform";

afterEach(() => vi.restoreAllMocks());

function provider(livemode: boolean, accountId = "acct_platformtest") {
  const stripe = new Stripe("placeholder");
  const account = vi.spyOn(stripe.accounts, "retrieve").mockResolvedValue({
    id: accountId,
    object: "account",
  } as Stripe.Response<Stripe.Account>);
  const balance = vi.spyOn(stripe.balance, "retrieve").mockResolvedValue({
    object: "balance",
    available: [],
    pending: [],
    livemode,
  } as Stripe.Response<Stripe.Balance>);
  return { stripe, account, balance };
}

it.each([false, true])(
  "accepts a real Account shape without livemode when Balance mode is %s",
  async (livemode) => {
    const { stripe, account, balance } = provider(livemode);
    await expect(
      assertStripePlatformIdentity(stripe, "acct_platformtest", livemode),
    ).resolves.toBeUndefined();
    expect(account).toHaveBeenCalledWith(null);
    expect(balance).toHaveBeenCalledWith();
  },
);

it("rejects a configured connected account even if the key can access it", async () => {
  const { stripe } = provider(false, "acct_keyowner");
  await expect(
    assertStripePlatformIdentity(stripe, "acct_connected", false),
  ).rejects.toThrow("Stripe platform identity does not match configuration");
});

it.each([false, true])(
  "rejects the wrong Balance mode (%s)",
  async (livemode) => {
    const { stripe } = provider(livemode);
    await expect(
      assertStripePlatformIdentity(stripe, "acct_platformtest", !livemode),
    ).rejects.toThrow("Stripe platform identity does not match configuration");
  },
);

it("does not authorize the platform when provider verification fails", async () => {
  const { stripe, balance } = provider(false);
  balance.mockRejectedValue(new Error("Stripe temporarily unavailable"));
  await expect(
    assertStripePlatformIdentity(stripe, "acct_platformtest", false),
  ).rejects.toThrow("Stripe temporarily unavailable");
});
