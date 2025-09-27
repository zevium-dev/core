import { autumn } from "autumn-js/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";
import { twoFactor } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { reactStartCookies } from "better-auth/react-start";

import type { Permissions } from "~/lib/permission";

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
              timezone: "UTC",
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
    apiKey({
      defaultPrefix: "zev_",
      enableMetadata: true,
      keyExpiration: {
        defaultExpiresIn: 30 * 24 * 60 * 60,
        maxExpiresIn: 365 * 24 * 60 * 60,
        minExpiresIn: 24 * 60 * 60,
      },
      permissions: { defaultPermissions: {} satisfies Permissions },
      // 200 requests per minute
      rateLimit: { enabled: true, maxRequests: 200, timeWindow: 1000 * 60 },
    }),
    twoFactor(),
    organization({ requireEmailVerificationOnInvitation: true }),
    autumn({ customerScope: "organization", secretKey: serverEnv.AUTUMN_SECRET_KEY }),
    capCaptcha(),
    reactStartCookies(),
  ],
  rateLimit: {
    // 200 requests per minute
    enabled: true,
    max: 200,
    storage: "secondary-storage",
    window: 1000 * 60,
  },
  secondaryStorage: {
    delete: async (key) => {
      await kv.del(BETTER_AUTH_KV_PREFIX + key);
    },
    get: async (key) => {
      return await kv.get(BETTER_AUTH_KV_PREFIX + key);
    },
    set: async (key, value, ttl) => {
      let pxMs: number | undefined;
      if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
        const ttlMs = ttl > 1000 * 1000 ? ttl : ttl * 1000;
        pxMs = Math.floor(ttlMs);
      } else if (ttl == null) {
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
