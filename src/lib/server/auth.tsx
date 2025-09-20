import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { reactStartCookies } from "better-auth/react-start";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { EMAIL_FROM } from "~/lib/constants";

import { sendEmail } from "../email";
import { EmailVerify, EmailVerifySubject } from "../email/templates/email-verify";
import { kv } from "../kv";
import { capCaptcha } from "./better-auth-captcha";

const BETTER_AUTH_KV_PREFIX = "better-auth:";

export const authServer = betterAuth({
  account: {
    accountLinking: {
      allowDifferentEmails: false,
      enabled: true,
      trustedProviders: ["email-password", "google"],
    },
  },
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  emailVerification: {
    autoSignInAfterVerification: true,
    sendVerificationEmail: async (opts, _req) => {
      await sendEmail({
        from: EMAIL_FROM,
        react: <EmailVerify fullUrl={opts.url} name={opts.user.name} />,
        subject: EmailVerifySubject,
        to: [opts.user.email],
      });
    },
  },
  plugins: [apiKey(), organization({ requireEmailVerificationOnInvitation: true }), capCaptcha(), reactStartCookies()],
  rateLimit: {
    storage: "secondary-storage",
  },
  secondaryStorage: {
    delete: async (key) => {
      await kv.del(BETTER_AUTH_KV_PREFIX + key);
    },
    get: async (key) => {
      return await kv.get(BETTER_AUTH_KV_PREFIX + key);
    },
    set: async (key, value, ttl) => {
      return await kv.set(BETTER_AUTH_KV_PREFIX + key, value, { ex: ttl ?? 30 * 24 * 60 * 60 });
    },
  },
  socialProviders: {
    google: {
      clientId: serverEnv.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: serverEnv.AUTH_GOOGLE_CLIENT_SECRET,
    },
  },
});

// Uncomment this for generating migrations
// export const auth = authServer;
