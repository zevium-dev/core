/**
 * Seed script: creates a default user + organization for local dev and CI.
 *
 * Usage:  pnpm db:seed
 *
 * Idempotent — safe to run multiple times. Checks for existing rows by
 * email/slug before inserting. Uses better-auth's `hashPassword` so the
 * password hash matches what the auth runtime produces.
 */
import "dotenv/config";

import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";

import { hashPassword } from "better-auth/crypto";
import { db, schema } from "../src/db";

const SEED_EMAIL = "user@example.com";
const SEED_PASSWORD = "password";
const SEED_NAME = "Test User";
const ORG_NAME = "Test Organization";
const ORG_SLUG = "test-org";

async function seed() {
  console.log("Seeding database...");

  // 1. User (idempotent)
  const existingUser = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, SEED_EMAIL))
    .limit(1)
    .then((r) => r.at(0));

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
    console.log(`  User already exists: ${SEED_EMAIL} (${userId})`);
  } else {
    userId = createId();
    const hashedPassword = await hashPassword(SEED_PASSWORD);
    await db.insert(schema.user).values({
      email: SEED_EMAIL,
      emailVerified: true,
      id: userId,
      name: SEED_NAME,
    });
    await db.insert(schema.account).values({
      accountId: userId,
      id: createId(),
      password: hashedPassword,
      providerId: "credential",
      userId,
    });
    console.log(`  Created user: ${SEED_EMAIL} (${userId})`);
  }

  // 2. Organization (idempotent)
  const existingOrg = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, ORG_SLUG))
    .limit(1)
    .then((r) => r.at(0));

  let orgId: string;
  if (existingOrg) {
    orgId = existingOrg.id;
    console.log(`  Organization already exists: ${ORG_SLUG} (${orgId})`);
  } else {
    orgId = createId();
    await db.insert(schema.organization).values({
      id: orgId,
      name: ORG_NAME,
      slug: ORG_SLUG,
    });
    console.log(`  Created organization: ${ORG_SLUG} (${orgId})`);
  }

  // 3. Membership (idempotent)
  const existingMember = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId))
    .limit(1)
    .then((r) => r.at(0));

  if (existingMember) {
    console.log(`  Membership already exists`);
  } else {
    await db.insert(schema.member).values({
      id: createId(),
      organizationId: orgId,
      role: "owner",
      userId,
    });
    console.log(`  Created membership (owner)`);
  }

  console.log("\nSeed complete:");
  console.log(`  Email:     ${SEED_EMAIL}`);
  console.log(`  Password:  ${SEED_PASSWORD}`);
  console.log(`  Org slug:  ${ORG_SLUG}`);
  console.log(`  Org name:  ${ORG_NAME}`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
