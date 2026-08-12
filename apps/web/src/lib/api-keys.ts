import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { ConvexHttpClient } from "convex/browser";

import { api } from "#/lib/convex-api";

export type ApiKeyRow = {
  id: string;
  name: string;
  /** Masked display form — secret never re-listed after create. */
  masked: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
};

export type CreateApiKeyResult = {
  id: string;
  name: string;
  secret: string;
  createdAt: number;
};

export type RotateApiKeyResult = CreateApiKeyResult & {
  graceUntil: number;
};

function requireUserId(userId: string | null | undefined): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Sign in to manage API keys");
  }
  return userId;
}

function requireOrganizationId(orgId: string | null | undefined): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new Error("Select an organization before managing API keys");
  }
  return orgId;
}

function maskKeyId(id: string): string {
  if (id.length <= 8) return "••••••••";
  return `••••${id.slice(-4)}`;
}

async function authenticatedConvex(session: {
  getToken: (options: { template: string }) => Promise<string | null>;
}): Promise<ConvexHttpClient> {
  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  const token = await session.getToken({ template: "convex" });
  if (!convexUrl || !token) {
    throw new Error(
      "Secure API key management is temporarily unavailable. Refresh and try again.",
    );
  }
  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(token);
  return convex;
}

/** Provider access lives behind Convex so one fenced saga owns every write. */
export const listKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiKeyRow[]> => {
    const session = await auth();
    requireUserId(session.userId);
    requireOrganizationId(session.orgId);
    const convex = await authenticatedConvex(session);
    const keys = await convex.action(api.keyBroker.listOwnedKeys, {});
    return keys
      .filter((key) => !key.revoked && !key.expired)
      .map((key) => ({
        id: key.id,
        name: key.name,
        masked: maskKeyId(key.id),
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revoked: key.revoked,
      }));
  },
);

export const createKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("name" in input)) {
      throw new Error("Name is required");
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0) throw new Error("Name is required");
    if (name.length > 64) {
      throw new Error("Name must be 64 characters or fewer");
    }
    const operationId =
      "operationId" in input && typeof input.operationId === "string"
        ? input.operationId.trim()
        : "";
    if (operationId.length < 8 || operationId.length > 128) {
      throw new Error("Creation operation is invalid");
    }
    return { name, operationId };
  })
  .handler(async ({ data }): Promise<CreateApiKeyResult> => {
    const session = await auth();
    requireUserId(session.userId);
    requireOrganizationId(session.orgId);
    const convex = await authenticatedConvex(session);
    return await convex.action(api.keyBroker.createManagedKey, data);
  });

export const revokeKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("id" in input)) {
      throw new Error("Key id is required");
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const operationId =
      "operationId" in input && typeof input.operationId === "string"
        ? input.operationId.trim()
        : "";
    if (id.length === 0) throw new Error("Key id is required");
    if (operationId.length < 8 || operationId.length > 128) {
      throw new Error("Revocation operation is invalid");
    }
    return { keyId: id, operationId };
  })
  .handler(async ({ data }): Promise<{ id: string }> => {
    const session = await auth();
    requireUserId(session.userId);
    requireOrganizationId(session.orgId);
    const convex = await authenticatedConvex(session);
    return await convex.action(api.keyBroker.revokeManagedKey, data);
  });

export const setKeyCap = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("keyId" in input)) {
      throw new Error("Key id is required");
    }
    const keyId = typeof input.keyId === "string" ? input.keyId.trim() : "";
    const monthlyCapCredits =
      "monthlyCapCredits" in input ? input.monthlyCapCredits : undefined;
    if (keyId.length === 0) throw new Error("Key id is required");
    if (
      monthlyCapCredits !== null &&
      (typeof monthlyCapCredits !== "number" ||
        !Number.isInteger(monthlyCapCredits) ||
        monthlyCapCredits <= 0)
    ) {
      throw new Error("Cap must be a positive whole number of credits");
    }
    return { keyId, monthlyCapCredits };
  })
  .handler(async ({ data }) => {
    const session = await auth();
    requireUserId(session.userId);
    requireOrganizationId(session.orgId);
    const convex = await authenticatedConvex(session);
    return await convex.action(api.keyBroker.setCap, data);
  });

export const setKeyDisabled = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (
      input === null ||
      typeof input !== "object" ||
      !("keyId" in input) ||
      !("disabled" in input)
    ) {
      throw new Error("Key status is invalid");
    }
    const keyId = typeof input.keyId === "string" ? input.keyId.trim() : "";
    if (keyId.length === 0 || typeof input.disabled !== "boolean") {
      throw new Error("Key status is invalid");
    }
    return { keyId, disabled: input.disabled };
  })
  .handler(async ({ data }) => {
    const session = await auth();
    requireUserId(session.userId);
    requireOrganizationId(session.orgId);
    const convex = await authenticatedConvex(session);
    return await convex.action(api.keyBroker.setDisabled, data);
  });

export const rotateKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (input === null || typeof input !== "object" || !("id" in input)) {
      throw new Error("Key id is required");
    }
    const oldKeyId = typeof input.id === "string" ? input.id.trim() : "";
    const name =
      "name" in input && typeof input.name === "string"
        ? input.name.trim()
        : "";
    const operationId =
      "operationId" in input && typeof input.operationId === "string"
        ? input.operationId.trim()
        : "";
    if (oldKeyId.length === 0) throw new Error("Key id is required");
    if (name.length > 64) {
      throw new Error("Name must be 64 characters or fewer");
    }
    if (operationId.length < 8 || operationId.length > 128) {
      throw new Error("Rotation operation is invalid");
    }
    return { oldKeyId, name, operationId };
  })
  .handler(async ({ data }): Promise<RotateApiKeyResult> => {
    const session = await auth();
    requireUserId(session.userId);
    requireOrganizationId(session.orgId);
    const convex = await authenticatedConvex(session);
    return await convex.action(api.keyBroker.rotateManagedKey, data);
  });
