/**
 * Seed default test user + org for local dev and E2E tests. Idempotent.
 *
 * Uses Clerk test mode: `+clerk_test` emails sign in with any password set
 * here and OTP 424242 without real email delivery.
 *
 *   pnpm seed
 *
 * Credentials: test+clerk_test@zevium.dev / zevium-test-password
 */
import { createClerkClient } from "@clerk/backend";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EMAIL = "test+clerk_test@zevium.dev";
const PASSWORD = "zevium-test-password";
const ORG_NAME = "Test Organization";
const ORG_SLUG = "test-org";

function loadSecretKey(): string {
  if (process.env.CLERK_SECRET_KEY) return process.env.CLERK_SECRET_KEY;
  const env = readFileSync(
    join(import.meta.dirname, "../apps/web/.env.local"),
    "utf8",
  );
  const match = env.match(/^CLERK_SECRET_KEY=(.+)$/m);
  if (!match)
    throw new Error("CLERK_SECRET_KEY not found in env or apps/web/.env.local");
  return match[1].trim();
}

const clerk = createClerkClient({ secretKey: loadSecretKey() });

async function main() {
  const existing = await clerk.users.getUserList({ emailAddress: [EMAIL] });
  const user =
    existing.data.at(0) ??
    (await clerk.users.createUser({
      emailAddress: [EMAIL],
      password: PASSWORD,
      firstName: "Test",
      lastName: "User",
      skipPasswordChecks: true,
    }));
  console.log(`user: ${user.id} (${EMAIL})`);

  const orgs = await clerk.organizations.getOrganizationList({
    query: ORG_SLUG,
  });
  const org =
    orgs.data.find((o) => o.slug === ORG_SLUG) ??
    (await clerk.organizations.createOrganization({
      name: ORG_NAME,
      slug: ORG_SLUG,
      createdBy: user.id,
    }));
  console.log(`org:  ${org.id} (${ORG_SLUG})`);

  const memberships = await clerk.organizations.getOrganizationMembershipList({
    organizationId: org.id,
  });
  if (!memberships.data.some((m) => m.publicUserData?.userId === user.id)) {
    await clerk.organizations.createOrganizationMembership({
      organizationId: org.id,
      userId: user.id,
      role: "org:admin",
    });
    console.log("membership: created (org:admin)");
  } else {
    console.log("membership: exists");
  }

  console.log(`\nseed OK — sign in: ${EMAIL} / ${PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
