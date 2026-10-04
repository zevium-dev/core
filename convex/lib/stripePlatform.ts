import type Stripe from "stripe";

/** Verify the key's own account, rather than a connected account it can access. */
export async function assertStripePlatformIdentity(
  stripe: Stripe,
  configuredAccountId: string,
  expectedLivemode: boolean,
): Promise<void> {
  const [account, balance] = await Promise.all([
    stripe.accounts.retrieve(null),
    stripe.balance.retrieve(),
  ]);
  // Accounts v1 have no livemode field; Balance reports the key's mode.
  if (
    account.id !== configuredAccountId ||
    balance.livemode !== expectedLivemode
  ) {
    throw new Error("Stripe platform identity does not match configuration");
  }
}
