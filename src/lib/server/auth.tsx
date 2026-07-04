import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { tanstackStartCookies } from "better-auth/tanstack-start";

import { db, schema } from "~/db";
import { clientEnv } from "~/env/client";
import { serverEnv } from "~/env/server";
import { EMAIL_FROM } from "~/lib/constants";

import { sendEmail } from "../email";
import { EmailVerify, EmailVerifySubject } from "../email/templates/email-verify";
import { OrganizationInvitationEmail, organizationInvitationSubject } from "../email/templates/organization-invitation";
import { ResetPasswordEmail, ResetPasswordSubject } from "../email/templates/reset-password";
import { capCaptcha } from "./better-auth-captcha";
import { kv } from "./kv";
import { ac, roles } from "./organization-access";
import { checkout, polar, portal, usage, webhooks } from "@polar-sh/better-auth";
import { polarClient, invalidateUserCreditedCache } from "./polar";

const BETTER_AUTH_KV_PREFIX = "better-auth:";

type OrganizationPluginOptions = NonNullable<Parameters<typeof organization>[0]>;
type OrganizationSendInvitationEmailData = Parameters<NonNullable<OrganizationPluginOptions["sendInvitationEmail"]>>[0];

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
    sendResetPassword: async (opts, _req) => {
      await sendEmail({
        from: EMAIL_FROM,
        react: (
          <ResetPasswordEmail
            fullUrl={clientEnv.VITE_PUBLIC_URL + `/auth/reset-password?token=${encodeURIComponent(opts.token)}`}
            name={opts.user.name}
          />
        ),
        subject: ResetPasswordSubject,
        to: [opts.user.email],
      });
    },
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
      // No expiry by default (v1).
      keyExpiration: { defaultExpiresIn: null },
      permissions: { defaultPermissions: { api: ["read"] } },
      // 60 requests per minute per key.
      rateLimit: { enabled: true, maxRequests: 60, timeWindow: 60_000 },
      // User-owned keys: referenceId = userId (Polar-native billing unit).
      references: "user",
    }),
    polar({
      client: polarClient,
      // Auto-create the Polar customer (externalId = userId) on signup so
      // the meter credits balance exists before the first top-up.
      createCustomerOnSignUp: true,
      use: [
        // Mounts POST /api/auth/checkout — accepts a fixed-product top-up.
        // Polar-native model: each top-up is a fixed-price one-time product
        // that grants fixed units via a meter_credit benefit. The
        // dashboard-provided product IDs are passed by the client from env.
        checkout({
          authenticatedUsersOnly: true,
          successUrl: `${clientEnv.VITE_PUBLIC_URL}/app/settings/credits?checkout_id={CHECKOUT_ID}`,
          returnUrl: `${clientEnv.VITE_PUBLIC_URL}/app/settings/credits`,
        }),
        // Mounts GET /api/auth/customer/state — the user's active meters,
        // balance, and consumed. Used by the balance RPC as the source of
        // truth when a session is available.
        portal(),
        usage(),
        // Mounts POST /api/auth/polar/webhooks — signature verification +
        // typed callbacks. Replaces the hand-rolled /api/polar/webhook route.
        webhooks({
          secret: serverEnv.POLAR_WEBHOOK_SECRET,
          onOrderPaid: async (payload) => {
            const userId = payload.data.customer.externalId;
            if (userId) await invalidateUserCreditedCache(userId);
          },
          onOrderRefunded: async (payload) => {
            const userId = payload.data.customer.externalId;
            if (userId) await invalidateUserCreditedCache(userId);
          },
          onCustomerStateChanged: async (payload) => {
            const userId = payload.data.externalId;
            if (userId) await invalidateUserCreditedCache(userId);
          },
        }),
      ],
    }),
    twoFactor(),
    organization({
      ac,
      requireEmailVerificationOnInvitation: true,
      roles,
      async sendInvitationEmail(data: OrganizationSendInvitationEmailData) {
        const redirectTo = "/app/invitations";
        const inviteLink = `${clientEnv.VITE_PUBLIC_URL}/auth/sign-in?redirectTo=${encodeURIComponent(redirectTo)}`;

        await sendEmail({
          from: EMAIL_FROM,
          react: (
            <OrganizationInvitationEmail
              invitedByEmail={data.inviter.user.email}
              invitedByName={data.inviter.user.name}
              inviteLink={inviteLink}
              organizationName={data.organization.name}
            />
          ),
          subject: organizationInvitationSubject(data.organization.name),
          to: [data.email],
        });
      },
    }),
    capCaptcha(),
    tanstackStartCookies(),
  ],
  rateLimit: {
    // 60 requests per minute
    enabled: true,
    max: 60,
    storage: "secondary-storage",
    window: 60,
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
// export const auth = authServer;
