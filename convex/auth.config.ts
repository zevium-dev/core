import type { AuthConfig } from "convex/server";

// Issuer = Clerk Frontend API domain from pk_test_<base64(domain$)>.
// VITE_CLERK_PUBLISHABLE_KEY=pk_test_aG9seS13YXNwLTk1LmNsZXJrLmFjY291bnRzLmRldiQ
// → holy-wasp-95.clerk.accounts.dev
export default {
  providers: [
    {
      domain: "https://holy-wasp-95.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
