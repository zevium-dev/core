import { autumn } from "autumn-js/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";
import { twoFactor } from "better-auth/plugins"
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
  appName: "Zevium",
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  databaseHooks: {
    user: {
      create: {
        after: async (user: { id: string }) => {
          try {
            await db.insert(schema.userPreference).values({
              timezone: 'UTC',
              userId: user.id,
            });
          } catch {
            // ignore duplicate or race
          }
        },
      },
    },
  },
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
  plugins: [
    apiKey(),
    twoFactor(),
    organization({ requireEmailVerificationOnInvitation: true }),
    autumn({ customerScope: "organization", secretKey: serverEnv.AUTUMN_SECRET_KEY }),
    capCaptcha(),
    reactStartCookies(),
  ],
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
      // Only set TTL if it is a finite positive number. Some callers may pass Infinity/undefined to mean no TTL.
      let pxMs: number | undefined;
      if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
        // Heuristic: if ttl looks like seconds, convert to ms; if it's already in ms, keep as is.
        const ttlMs = ttl > 1000 * 1000 ? ttl : ttl * 1000;
        pxMs = Math.floor(ttlMs);
      } else if (ttl == null) {
        // Default to ~24 days when ttl is not provided at all (fits within 32-bit ms range)
        pxMs = 24 * 24 * 60 * 60 * 1000;
      }

      // Cap px to Redis/Upstash safe max (~2_147_483_647 ms)
      const MAX_PX = 2147483647;
      if (typeof pxMs === "number") {
        pxMs = Math.min(pxMs, MAX_PX);
      }

      // Omit options entirely if pxMs is undefined to satisfy strict union types
      return pxMs
        ? await kv.set(BETTER_AUTH_KV_PREFIX + key, value, { px: pxMs })
        : await kv.set(BETTER_AUTH_KV_PREFIX + key, value);
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
//export const auth = authServer;
