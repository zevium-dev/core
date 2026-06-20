import Cap from "@cap.js/server";

import { kv } from "~/lib/server/kv";

export type Solution = Cap.Solution;

const CAP_KV_PREFIX = "cap:";

export const cap = new Cap({
  noFSState: true,
  storage: {
    challenges: {
      delete: async (token) => {
        await kv.del(CAP_KV_PREFIX + token);
      },
      deleteExpired: async () => {}, // KV has its own TTL, no cleanup needed
      read: async (token) => {
        const data = await kv.get<Cap.ChallengeData>(CAP_KV_PREFIX + token);
        if (!data) return null;
        return data;
      },
      store: async (token, challengeData) => {
        await kv.set(CAP_KV_PREFIX + token, challengeData, { pxat: challengeData.expires });
      },
    },
    tokens: {
      delete: async (tokenKey) => {
        await kv.del(CAP_KV_PREFIX + tokenKey);
      },
      deleteExpired: async () => {}, // KV has its own TTL, no cleanup needed
      get: async (tokenKey) => {
        const data = await kv.get<string>(CAP_KV_PREFIX + tokenKey);
        if (!data) return null;
        return parseInt(data, 10);
      },
      store: async (tokenKey, expires) => {
        await kv.set(CAP_KV_PREFIX + tokenKey, expires.toString(), { pxat: expires });
      },
    },
  },
});
