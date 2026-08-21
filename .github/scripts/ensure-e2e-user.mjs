import { createClerkClient } from "@clerk/backend";

const secretKey = process.env.CLERK_PREVIEW_SECRET_KEY;
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

if (!secretKey || !email || !password) {
  throw new Error(
    "CLERK_PREVIEW_SECRET_KEY, E2E_EMAIL, and E2E_PASSWORD are required",
  );
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("E2E_EMAIL must be a valid email address");
}
if (password.length < 8) {
  throw new Error("E2E_PASSWORD must be at least 8 characters");
}

const client = createClerkClient({ secretKey });

const orgSlug = process.env.E2E_ORG_SLUG || "zevium-e2e";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(orgSlug)) {
  throw new Error("E2E_ORG_SLUG must be a lowercase kebab-case slug");
}

const existing = await client.users.getUserList({
  emailAddress: [email],
  limit: 1,
});

let userId;
if (existing.data.length === 0) {
  const created = await client.users.createUser({
    emailAddress: [email],
    password,
    skipPasswordChecks: true,
    skipPasswordRequirement: false,
  });
  userId = created.id;
  console.log("[e2e] provisioned preview sign-in user (created)");
} else {
  userId = existing.data[0].id;
  await client.users.updateUser(userId, {
    password,
    skipPasswordChecks: true,
  });
  console.log("[e2e] provisioned preview sign-in user (password rotated)");
}

const orgs = await client.organizations.getOrganizationList({
  query: orgSlug,
  limit: 10,
});
const org = orgs.data.find((candidate) => candidate.slug === orgSlug);
let organizationId;
if (!org) {
  const createdOrg = await client.organizations.createOrganization({
    name: orgSlug,
    slug: orgSlug,
    createdBy: userId,
  });
  organizationId = createdOrg.id;
  console.log("[e2e] provisioned preview organization (created)");
} else {
  organizationId = org.id;
  console.log("[e2e] provisioned preview organization (reused)");
}

const memberships = await client.organizations.getOrganizationMembershipList({
  organizationId,
  limit: 100,
});
if (!memberships.data.some((m) => m.publicUserData?.userId === userId)) {
  await client.organizations.createOrganizationMembership({
    organizationId,
    userId,
    role: "org:admin",
  });
  console.log("[e2e] added e2e user to preview organization");
}
