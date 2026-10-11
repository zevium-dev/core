import type { AuthConfig } from "convex/server";

const clerkIssuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (clerkIssuerDomain === undefined || clerkIssuerDomain.length === 0) {
  throw new Error("CLERK_JWT_ISSUER_DOMAIN is not configured");
}

export default {
  providers: [
    {
      domain: clerkIssuerDomain,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
