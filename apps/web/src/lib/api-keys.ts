import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import {
  sealOneTimeExecutionKey,
  signRegistryVerifiedKeyProjection,
  signRegistryVerifiedKeyRotationProjection,
  type RegistryVerifiedKeyProjection,
  type RegistryVerifiedKeyRotationProjection,
} from "@zevium/shared";

import { getApiKeyLifecycle } from "#/lib/api-key-lifecycle";
import { api } from "#/lib/convex-api";

export type ApiKeyRow = {
  id: string;
  name: string;
  ownerUserId?: string;
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
    throw new ConvexError("Sign in to manage API keys");
  }
  return userId;
}

function requireProjectionSecret(): string {
  const secret = process.env.REGISTRY_KEY_PROJECTION_HMAC_SECRET;
  if (!secret) {
    throw new ConvexError(
      "Secure key registration is temporarily unavailable. Try again later.",
    );
  }
  return secret;
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

/** Create one key for the current user. Secret returned once. Enforces one-key rule. */
export const createKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("name" in input)) {
      throw new ConvexError("Name is required");
    }
    const raw = input.name;
    if (typeof raw !== "string") {
      throw new ConvexError("Name is required");
    }
    const name = raw.trim();
    if (name.length === 0) {
      throw new ConvexError("Name is required");
    }
    if (name.length > 64) {
      throw new ConvexError("Name must be 64 characters or fewer");
    }
    return { name };
  })
  .handler(async ({ data }): Promise<CreateApiKeyResult> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const orgId = session.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new ConvexError(
        "Select an organization before creating an API key",
      );
    }
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    const token = (await session.getToken({ template: "convex" })) ?? null;
    const projectionSecret = requireProjectionSecret();
    if (!convexUrl || !token) {
      throw new ConvexError(
        "Secure key registration is temporarily unavailable. Refresh and try again.",
      );
    }
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);
    const client = await clerkClient();

    const created = await client.apiKeys.create({
      name: data.name,
      subject: userId,
      createdBy: userId,
      claims: { org_id: orgId },
    });

    try {
      const secret = created.secret;
      if (typeof secret !== "string" || secret.length === 0) {
        throw new ConvexError(
          "Key created but secret missing. Contact support.",
        );
      }
      const sealed = await sealOneTimeExecutionKey({
        keyId: created.id,
        secret,
        clerkOrgId: orgId,
        ownerUserId: userId,
        subjectUserId: userId,
        budgetId: `budget_${crypto.randomUUID().replaceAll("-", "")}`,
        budgetRevision: 1,
        scopes: ["gateway:execute"],
      });
      const projection: RegistryVerifiedKeyProjection = {
        schemaVersion: 1,
        verifiedAt: Date.now(),
        provision: sealed.provision,
      };
      await convex.mutation(api.keySettings.registerVerified, {
        projection,
        keyName: created.name,
        signature: await signRegistryVerifiedKeyProjection(
          projectionSecret,
          projection,
        ),
      });
      return {
        id: created.id,
        name: created.name,
        secret,
        createdAt: created.createdAt,
      };
    } catch (error) {
      // Registration may have committed before a response was lost. Close any
      // projection before revoking the provider key; missing rows are harmless.
      await convex
        .mutation(api.keySettings.revokePrevious, { keyId: created.id })
        .catch(() => undefined);
      await client.apiKeys.revoke({
        apiKeyId: created.id,
        revocationReason: "Zevium key projection failed",
      });
      throw error;
    }
  });

/** Revoke an owned key, or any active-org key for an org admin. */
export const revokeKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("id" in input)) {
      throw new ConvexError("Key id is required");
    }
    const raw = input.id;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new ConvexError("Key id is required");
    }
    return { id: raw.trim() };
  })
  .handler(
    async ({
      data,
    }): Promise<{ id: string; providerCleanupPending: boolean }> => {
      const session = await auth();
      requireUserId(session.userId);
      const orgId = session.orgId;
      if (typeof orgId !== "string" || orgId.length === 0) {
        throw new ConvexError(
          "Select an organization before revoking an API key",
        );
      }
      const client = await clerkClient();
      const convexUrl = import.meta.env.VITE_CONVEX_URL;
      const token = (await session.getToken({ template: "convex" })) ?? null;
      if (!convexUrl || !token) {
        throw new ConvexError(
          "Secure key revocation is temporarily unavailable. Refresh and try again.",
        );
      }
      const convex = new ConvexHttpClient(convexUrl);
      convex.setAuth(token);

      await convex.mutation(api.keySettings.revokePrevious, { keyId: data.id });
      try {
        const key = await client.apiKeys.get(data.id);
        if (!key.revoked) {
          await client.apiKeys.revoke({
            apiKeyId: data.id,
            revocationReason: "Revoked from Zevium settings",
          });
        }
      } catch {
        // Durable cleanup was queued with the local revoke; never restore access.
        return { id: data.id, providerCleanupPending: true };
      }
      return { id: data.id, providerCleanupPending: false };
    },
  );

/**
 * Rotate a key: create a replacement (same org claim; the one-key rule does not
 * apply to rotation), keep the old key live at the gateway for the grace
 * window. The secret is returned once. The signed projection records rotation lineage atomically in Convex.
 */
export const rotateKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("id" in input)) {
      throw new ConvexError("Key id is required");
    }
    const id = input.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ConvexError("Key id is required");
    }
    const name =
      "name" in input && typeof input.name === "string"
        ? input.name.trim()
        : "";
    if (name.length > 64) {
      throw new ConvexError("Name must be 64 characters or fewer");
    }
    const operationId =
      "operationId" in input && typeof input.operationId === "string"
        ? input.operationId.trim()
        : "";
    if (operationId.length < 8 || operationId.length > 128) {
      throw new ConvexError("Rotation operation is invalid");
    }
    return { id: id.trim(), name, operationId };
  })
  .handler(async ({ data }): Promise<RotateApiKeyResult> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const orgId = session.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new ConvexError(
        "Select an organization before rotating an API key",
      );
    }
    const client = await clerkClient();
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    const token = (await session.getToken({ template: "convex" })) ?? null;
    if (!convexUrl || !token) {
      throw new ConvexError(
        "Secure key rotation is temporarily unavailable. Refresh and try again.",
      );
    }
    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(token);
    const projectionSecret = requireProjectionSecret();
    const operation = await convex.mutation(api.keySettings.beginRotation, {
      operationId: data.operationId,
      oldKeyId: data.id,
    });
    if (!operation) {
      throw new ConvexError("Could not reserve this rotation. Try again.");
    }
    if (operation.status === "completed") {
      throw new ConvexError(
        "This rotation already completed. The one-time secret cannot be shown again; revoke the previous key or create a new key.",
      );
    }
    if (operation.status === "failed") {
      throw new ConvexError(
        "This rotation previously failed. Start a new rotation.",
      );
    }

    // Convex already authorized this key for its owner or an org admin.
    const old = await client.apiKeys.get(data.id);
    if (!keyBelongsToOrganization(old, orgId) || old.revoked || old.expired) {
      throw new ConvexError("This key is no longer active");
    }
    const settings = await convex.query(api.keySettings.getForOrg, {});
    const now = Date.now();
    const currentSetting = settings.find(
      (setting) => setting.keyId === data.id,
    );
    if (currentSetting?.ownerUserId !== old.subject)
      throw new ConvexError("Key not found");
    if (getApiKeyLifecycle(currentSetting, now) !== "current") {
      throw new ConvexError("Only the current key can be rotated");
    }
    const supersededKeyId = currentSetting?.rotatedFromKeyId;
    if (
      settings.some(
        (setting) =>
          setting.ownerUserId === old.subject &&
          getApiKeyLifecycle(setting, now) === "grace" &&
          setting.keyId !== supersededKeyId,
      )
    ) {
      throw new ConvexError(
        "Revoke the unrelated grace key before rotating again",
      );
    }
    if (supersededKeyId !== undefined) {
      const superseded = await client.apiKeys.get(supersededKeyId);
      if (
        superseded.subject !== old.subject ||
        !keyBelongsToOrganization(superseded, orgId)
      ) {
        throw new ConvexError("Previous key not found");
      }
      await convex.mutation(api.keySettings.revokePrevious, {
        keyId: supersededKeyId,
      });
      if (!superseded.revoked) {
        await client.apiKeys.revoke({
          apiKeyId: supersededKeyId,
          revocationReason: "Superseded by chained rotation",
        });
      }
    }

    let created;
    try {
      created = await client.apiKeys.create({
        name: data.name.length > 0 ? data.name : `${old.name} (rotated)`,
        subject: old.subject,
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
      throw new ConvexError("Key created but secret missing. Contact support.");
    }

    const verifiedAt = Date.now();
    const graceUntil = verifiedAt + ROTATION_GRACE_MS;
    try {
      const oldBudget = settings.find(
        (setting) => setting.keyId === old.id,
      )?.budgetId;
      if (!oldBudget)
        throw new ConvexError(
          "Key budget is unavailable; rotate after security migration",
        );
      const sealed = await sealOneTimeExecutionKey(
        {
          keyId: created.id,
          secret,
          clerkOrgId: orgId,
          ownerUserId: old.subject,
          subjectUserId: old.subject,
          budgetId: oldBudget,
          budgetRevision:
            (settings.find((setting) => setting.keyId === old.id)
              ?.budgetRevision ?? 0) + 1,
          scopes: ["gateway:execute"],
        },
        { monthlyCapCredits: currentSetting.monthlyCapCredits },
      );
      const projection: RegistryVerifiedKeyRotationProjection = {
        schemaVersion: 1,
        verifiedAt,
        operationId: data.operationId,
        oldKeyId: old.id,
        newProvision: sealed.provision,
        graceUntil,
      };
      await convex.mutation(api.keySettings.completeRotation, {
        projection,
        keyName: created.name,
        signature: await signRegistryVerifiedKeyRotationProjection(
          projectionSecret,
          projection,
        ),
      });
      return {
        id: created.id,
        name: created.name,
        secret,
        createdAt: created.createdAt,
        graceUntil,
      };
    } catch (error) {
      // Registration may have committed before a response was lost. Close any
      // projection before revoking the provider key; missing rows are harmless.
      await convex
        .mutation(api.keySettings.revokePrevious, { keyId: created.id })
        .catch(() => undefined);
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
