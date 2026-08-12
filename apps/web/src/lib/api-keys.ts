import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { ConvexHttpClient } from "convex/browser";

import { getApiKeyLifecycle } from "#/lib/api-key-lifecycle";
import { api } from "#/lib/convex-api";

export type ApiKeyRow = {
  id: string;
  name: string;
  /** Masked display form — secret never re-listed after create. */
  masked: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  current: boolean;
};

export type CreateApiKeyResult = {
  id: string;
  name: string;
  secret: string;
  createdAt: number;
};

export type RotateApiKeyResult = {
  id: string;
  name: string;
  secret: string;
  createdAt: number;
  /** Old key keeps working until this ms epoch. Recorded in Convex by caller. */
  graceUntil: number;
};

/** Rotation grace window: the old key stays valid at the gateway for 24h. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

function requireUserId(userId: string | null | undefined): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Sign in to manage API keys");
  }
  return userId;
}

function maskKeyId(id: string): string {
  if (id.length <= 8) return "••••••••";
  return `••••${id.slice(-4)}`;
}

function toRow(
  key: {
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
    revoked: boolean;
  },
  current: boolean,
): ApiKeyRow {
  return {
    id: key.id,
    name: key.name,
    masked: maskKeyId(key.id),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revoked: key.revoked,
    current,
  };
}

function keyBelongsToOrganization(
  key: { claims?: unknown },
  orgId: string,
): boolean {
  const claims = key.claims;
  return (
    claims !== null &&
    typeof claims === "object" &&
    "org_id" in claims &&
    typeof claims.org_id === "string" &&
    claims.org_id === orgId
  );
}

/** List non-revoked API keys for signed-in user in active org. */
export const listKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiKeyRow[]> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const orgId = session.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new Error("Select an organization before managing API keys");
    }
    const client = await clerkClient();
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    const token = (await session.getToken({ template: "convex" })) ?? null;
    if (!convexUrl || !token) {
      throw new Error(
        "Secure key listing is temporarily unavailable. Refresh and try again.",
      );
    }
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);
    const [page, settings] = await Promise.all([
      client.apiKeys.list({
        subject: userId,
        includeInvalid: false,
        limit: 100,
      }),
      convex.query(api.keySettings.getForOrg, {}),
    ]);
    const settingsByKey = new Map(
      settings.map((setting) => [setting.keyId, setting]),
    );
    const now = Date.now();
    return page.data
      .filter((k) => !k.revoked && !k.expired)
      .filter((k) => {
        const claims = k.claims;
        if (!claims || typeof claims !== "object") return false;
        return (
          "org_id" in claims &&
          typeof claims.org_id === "string" &&
          claims.org_id === orgId
        );
      })
      .map((k) =>
        toRow(
          k,
          getApiKeyLifecycle(settingsByKey.get(k.id), now) === "current",
        ),
      );
  },
);

/** Create one key for the current user. Secret returned once. Enforces one-key rule. */
export const createKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("name" in input)) {
      throw new Error("Name is required");
    }
    const raw = input.name;
    if (typeof raw !== "string") {
      throw new Error("Name is required");
    }
    const name = raw.trim();
    if (name.length === 0) {
      throw new Error("Name is required");
    }
    if (name.length > 64) {
      throw new Error("Name must be 64 characters or fewer");
    }
    return { name };
  })
  .handler(async ({ data }): Promise<CreateApiKeyResult> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const orgId = session.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new Error("Select an organization before creating an API key");
    }
    const client = await clerkClient();
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    const token = (await session.getToken({ template: "convex" })) ?? null;
    if (!convexUrl || !token) {
      throw new Error(
        "Secure key creation is temporarily unavailable. Refresh and try again.",
      );
    }
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);

    const [existing, settings] = await Promise.all([
      client.apiKeys.list({
        subject: userId,
        includeInvalid: false,
        limit: 100,
      }),
      convex.query(api.keySettings.getForOrg, {}),
    ]);
    const settingsByKey = new Map(
      settings.map((setting) => [setting.keyId, setting]),
    );
    const now = Date.now();
    const active = existing.data.some((k) => {
      if (k.revoked || k.expired) return false;
      const claims = k.claims;
      if (!claims || typeof claims !== "object") return false;
      const belongsToOrg =
        "org_id" in claims &&
        typeof claims.org_id === "string" &&
        claims.org_id === orgId;
      return (
        belongsToOrg &&
        getApiKeyLifecycle(settingsByKey.get(k.id), now) === "current"
      );
    });
    if (active) {
      throw new Error(
        "Only one API key per member in this organization. Ask an admin to revoke or rotate the existing key.",
      );
    }

    const created = await client.apiKeys.create({
      name: data.name,
      subject: userId,
      createdBy: userId,
      claims: { org_id: orgId },
    });

    const secret = created.secret;
    if (typeof secret !== "string" || secret.length === 0) {
      // create should return secret once; fail closed rather than show empty
      throw new Error("Key created but secret missing. Contact support.");
    }

    try {
      await convex.mutation(api.keySettings.registerOwnedKey, {
        keyId: created.id,
        keyName: created.name,
      });
    } catch (error) {
      await client.apiKeys.revoke({
        apiKeyId: created.id,
        revocationReason: "Zevium attribution recording failed",
      });
      throw error;
    }

    return {
      id: created.id,
      name: created.name,
      secret,
      createdAt: created.createdAt,
    };
  });

/** Revoke a key owned by the current user. */
export const revokeKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("id" in input)) {
      throw new Error("Key id is required");
    }
    const raw = input.id;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error("Key id is required");
    }
    return { id: raw.trim() };
  })
  .handler(async ({ data }): Promise<{ id: string }> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const orgId = session.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new Error("Select an organization before revoking an API key");
    }
    const client = await clerkClient();
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    const token = (await session.getToken({ template: "convex" })) ?? null;
    if (!convexUrl || !token) {
      throw new Error(
        "Secure key revocation is temporarily unavailable. Refresh and try again.",
      );
    }
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);

    const key = await client.apiKeys.get(data.id);
    if (key.subject !== userId || !keyBelongsToOrganization(key, orgId)) {
      throw new Error("Key not found");
    }
    if (!key.revoked) {
      await client.apiKeys.revoke({
        apiKeyId: data.id,
        revocationReason: "Revoked by user from settings",
      });
    }
    await convex.mutation(api.keySettings.revokePrevious, {
      keyId: data.id,
    });
    return { id: data.id };
  });

/**
 * Rotate a key: create a replacement (same org claim; the one-key rule does not
 * apply to rotation), keep the old key live at the gateway for the grace
 * window. The secret is returned once. The caller records the rotation
 * (graceUntil on the old key, lineage on the new) in Convex.
 */
export const rotateKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("id" in input)) {
      throw new Error("Key id is required");
    }
    const id = input.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("Key id is required");
    }
    const name =
      "name" in input && typeof input.name === "string"
        ? input.name.trim()
        : "";
    if (name.length > 64) {
      throw new Error("Name must be 64 characters or fewer");
    }
    const operationId =
      "operationId" in input && typeof input.operationId === "string"
        ? input.operationId.trim()
        : "";
    if (operationId.length < 8 || operationId.length > 128) {
      throw new Error("Rotation operation is invalid");
    }
    return { id: id.trim(), name, operationId };
  })
  .handler(async ({ data }): Promise<RotateApiKeyResult> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const orgId = session.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new Error("Select an organization before rotating an API key");
    }
    const client = await clerkClient();
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    const token = (await session.getToken({ template: "convex" })) ?? null;
    if (!convexUrl || !token) {
      throw new Error(
        "Secure key rotation is temporarily unavailable. Refresh and try again.",
      );
    }
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);
    // Verify the old key belongs to this user.
    const old = await client.apiKeys.get(data.id);
    if (old.subject !== userId || !keyBelongsToOrganization(old, orgId)) {
      throw new Error("Key not found");
    }
    if (old.revoked || old.expired) {
      throw new Error("This key is no longer active");
    }
    const operation = await convex.mutation(api.keySettings.beginRotation, {
      operationId: data.operationId,
      oldKeyId: data.id,
    });
    if (!operation) {
      throw new Error("Could not reserve this rotation. Try again.");
    }
    if (operation.status === "completed") {
      throw new Error(
        "This rotation already completed. The one-time secret cannot be shown again; revoke the previous key or create a new key.",
      );
    }
    if (operation.status === "failed") {
      throw new Error("This rotation previously failed. Start a new rotation.");
    }

    const settings = await convex.query(api.keySettings.getForOrg, {});
    const now = Date.now();
    const currentSetting = settings.find(
      (setting) => setting.keyId === data.id,
    );
    if (getApiKeyLifecycle(currentSetting, now) !== "current") {
      throw new Error("Only the current key can be rotated");
    }
    const supersededKeyId = currentSetting?.rotatedFromKeyId;
    if (
      settings.some(
        (setting) =>
          getApiKeyLifecycle(setting, now) === "grace" &&
          setting.keyId !== supersededKeyId,
      )
    ) {
      throw new Error("Revoke the unrelated grace key before rotating again");
    }
    if (supersededKeyId !== undefined) {
      const superseded = await client.apiKeys.get(supersededKeyId);
      if (
        superseded.subject !== userId ||
        !keyBelongsToOrganization(superseded, orgId)
      ) {
        throw new Error("Previous key not found");
      }
      if (!superseded.revoked) {
        await client.apiKeys.revoke({
          apiKeyId: supersededKeyId,
          revocationReason: "Superseded by chained rotation",
        });
      }
      await convex.mutation(api.keySettings.revokePrevious, {
        keyId: supersededKeyId,
      });
    }

    let created;
    try {
      created = await client.apiKeys.create({
        name: data.name.length > 0 ? data.name : `${old.name} (rotated)`,
        subject: userId,
        createdBy: userId,
        claims: { org_id: orgId },
      });
    } catch (error) {
      await convex.mutation(api.keySettings.failRotation, {
        operationId: data.operationId,
        message: "Clerk replacement creation failed",
      });
      throw error;
    }

    const secret = created.secret;
    if (typeof secret !== "string" || secret.length === 0) {
      await client.apiKeys.revoke({
        apiKeyId: created.id,
        revocationReason: "Rotation secret was not returned",
      });
      await convex.mutation(api.keySettings.failRotation, {
        operationId: data.operationId,
        message: "Clerk replacement secret missing",
      });
      throw new Error("Key created but secret missing. Contact support.");
    }

    const graceUntil = Date.now() + ROTATION_GRACE_MS;
    try {
      await convex.mutation(api.keySettings.completeRotation, {
        operationId: data.operationId,
        oldKeyId: old.id,
        newKeyId: created.id,
        graceUntil,
      });
      await convex.mutation(api.keySettings.registerOwnedKey, {
        keyId: created.id,
        keyName: created.name,
      });
      return {
        id: created.id,
        name: created.name,
        secret,
        createdAt: created.createdAt,
        graceUntil,
      };
    } catch (error) {
      await client.apiKeys.revoke({
        apiKeyId: created.id,
        revocationReason: "Rotation lineage recording failed",
      });
      await convex.mutation(api.keySettings.failRotation, {
        operationId: data.operationId,
        message: "Lineage recording failed",
      });
      throw error;
    }
  });
