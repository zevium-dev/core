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
      listExpired: async () => {
        return await Promise.resolve([]); // No need to clean up since we're using KV which has its own TTL mechanism
      },
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
      get: async (tokenKey) => {
        const data = await kv.get<string>(CAP_KV_PREFIX + tokenKey);
        if (!data) return null;
        return parseInt(data, 10);
      },
      listExpired: async () => {
        return await Promise.resolve([]); // No need to clean up since we're using KV which has its own TTL mechanism
      },
      store: async (tokenKey, expires) => {
        await kv.set(CAP_KV_PREFIX + tokenKey, expires.toString(), { pxat: expires });
      },
    },
  },
});
