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

const existing = await client.users.getUserList({
  emailAddress: [email],
  limit: 1,
});

if (existing.data.length === 0) {
  await client.users.createUser({
    emailAddress: [email],
    password,
    skipPasswordChecks: true,
    skipPasswordRequirement: false,
  });
  console.log("[e2e] provisioned preview sign-in user (created)");
} else {
  await client.users.updateUser(existing.data[0].id, {
    password,
    skipPasswordChecks: true,
  });
  console.log("[e2e] provisioned preview sign-in user (password rotated)");
}
