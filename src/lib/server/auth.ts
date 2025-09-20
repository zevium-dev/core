import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";
import { reactStartCookies } from "better-auth/react-start";

import { db } from "~/db"; // your drizzle instance
import * as schema from "~/db/schema";
import { serverEnv } from "~/env/server";

export const authServer = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  plugins: [apiKey(), reactStartCookies()],
  socialProviders: {
    google: {
      clientId: serverEnv.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: serverEnv.AUTH_GOOGLE_CLIENT_SECRET,
    },
  },
  user: {
    deleteUser: {
      enabled: true
    },
    additionalFields: {
      timezone: {
        type: "string",
        required: false,
        defaultValue: "Asia/Kolkata",
      },
    }
  },
});

export const auth = authServer;
