import Cap from "@cap.js/server";

import { db, orm, schema } from "~/db";

export type Solution = Cap.Solution;

// TODO: cap stores the solutions in memory. Need to fix that
export const cap = new Cap({
  noFSState: true,
  storage: {
    challenges: {
      delete: async (token) => {
        await db.delete(schema.captchaChallenge).where(orm.eq(schema.captchaChallenge.token, token));
      },
      listExpired: async () => {
        const rows = await db
          .select()
          .from(schema.captchaChallenge)
          .where(orm.lt(schema.captchaChallenge.expires, new Date()));
        return rows.map((r) => r.token);
      },
      read: async (token) => {
        const row = await db
          .select()
          .from(schema.captchaChallenge)
          .where(
            orm.and(orm.eq(schema.captchaChallenge.token, token), orm.gt(schema.captchaChallenge.expires, new Date())),
          )
          .then((v) => v.at(0));
        if (!row) return null;
        return {
          challenge: row.data,
          expires: row.expires.getTime(),
        } as Cap.ChallengeData;
      },
      store: async (token, challengeData) => {
        await db.transaction(async (tx) => {
          const existingChallenge = await tx
            .select()
            .from(schema.captchaChallenge)
            .where(orm.eq(schema.captchaChallenge.token, token))
            .then((v) => v.at(0));
          if (!existingChallenge) {
            await tx
              .insert(schema.captchaChallenge)
              .values({ data: challengeData.challenge, expires: new Date(challengeData.expires), token });
          } else {
            await tx
              .update(schema.captchaChallenge)
              .set({ data: challengeData.challenge, expires: new Date(challengeData.expires) })
              .where(orm.eq(schema.captchaChallenge.token, token));
          }
        });
      },
    },
    tokens: {
      delete: async (tokenKey) => {
        await db.delete(schema.captchaToken).where(orm.eq(schema.captchaToken.key, tokenKey));
      },
      get: async (tokenKey) => {
        const row = await db
          .select()
          .from(schema.captchaToken)
          .where(orm.and(orm.eq(schema.captchaToken.key, tokenKey), orm.gt(schema.captchaToken.expires, new Date())))
          .then((v) => v.at(0));
        if (!row) return null;
        return row.expires.getTime();
      },
      listExpired: async () => {
        const rows = await db.select().from(schema.captchaToken).where(orm.lt(schema.captchaToken.expires, new Date()));
        return rows.map((r) => r.key);
      },
      store: async (tokenKey, expires) => {
        await db.transaction(async (tx) => {
          const existing = await tx
            .select()
            .from(schema.captchaToken)
            .where(orm.eq(schema.captchaToken.key, tokenKey))
            .then((v) => v.at(0));
          if (existing) {
            await tx
              .update(schema.captchaToken)
              .set({ expires: new Date(expires) })
              .where(orm.eq(schema.captchaToken.key, tokenKey));
          } else {
            await tx.insert(schema.captchaToken).values({ expires: new Date(expires), key: tokenKey });
          }
        });
      },
    },
  },
});
