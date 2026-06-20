import { createHash } from "node:crypto";

import {
  generateChallenge,
  validateChallenge,
  type ChallengeResult,
  type ValidateChallengeBody,
  type ValidateChallengeResult,
} from "capjs-core";

import { serverEnv } from "~/env/server";
import { kv } from "~/lib/server/kv";

const CAP_KV_PREFIX = "cap:";
const CAP_SECRET = serverEnv.CAP_SECRET;

export type Solution = ValidateChallengeBody;

export const createChallenge = (): Promise<ChallengeResult> => {
  return generateChallenge(CAP_SECRET);
};

export const redeemChallenge = async (body: Solution): Promise<ValidateChallengeResult> => {
  const result = await validateChallenge(CAP_SECRET, body, {
    consumeNonce: async (sigHex, ttlMs) => {
      const key = CAP_KV_PREFIX + sigHex;
      const existing = await kv.get(key);
      if (existing) return false;
      await kv.set(key, "1", { pxat: Date.now() + ttlMs });
      return true;
    },
  });

  if (!result.success) return result;

  const tokenKey = getTokenKey(result.token);
  await kv.set(CAP_KV_PREFIX + tokenKey, result.expires.toString(), { pxat: result.expires });

  return result;
};

export const validateToken = async (token: string): Promise<{ success: boolean }> => {
  const tokenKey = getTokenKey(token);
  const expires = await kv.get<string>(CAP_KV_PREFIX + tokenKey);
  if (!expires) return { success: false };
  if (Date.now() > parseInt(expires, 10)) return { success: false };
  return { success: true };
};

function getTokenKey(token: string): string {
  const [id, verToken] = token.split(":");
  if (!id || !verToken) return token;
  return `${id}:${createHash("sha256").update(verToken).digest("hex")}`;
}
