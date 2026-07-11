import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";

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

function toRow(key: {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}): ApiKeyRow {
  return {
    id: key.id,
    name: key.name,
    masked: maskKeyId(key.id),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revoked: key.revoked,
  };
}

/** List non-revoked API keys for the signed-in user (subject = userId). */
export const listKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiKeyRow[]> => {
    const session = await auth();
    const userId = requireUserId(session.userId);
    const client = await clerkClient();
    const page = await client.apiKeys.list({
      subject: userId,
      includeInvalid: false,
      limit: 100,
    });
    return page.data
      .filter((k) => !k.revoked && !k.expired)
      .map((k) => toRow(k));
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
    const client = await clerkClient();

    const existing = await client.apiKeys.list({
      subject: userId,
      includeInvalid: false,
      limit: 1,
    });
    const active = existing.data.some((k) => !k.revoked && !k.expired);
    if (active) {
      throw new Error("Only one API key per user. Revoke the existing key first.");
    }

    const created = await client.apiKeys.create({
      name: data.name,
      subject: userId,
      createdBy: userId,
    });

    const secret = created.secret;
    if (typeof secret !== "string" || secret.length === 0) {
      // create should return secret once; fail closed rather than show empty
      throw new Error("Key created but secret missing. Contact support.");
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
    const client = await clerkClient();

    const key = await client.apiKeys.get(data.id);
    if (key.subject !== userId) {
      throw new Error("Key not found");
    }
    if (key.revoked) {
      return { id: key.id };
    }

    await client.apiKeys.revoke({
      apiKeyId: data.id,
      revocationReason: "Revoked by user from settings",
    });
    return { id: data.id };
  });
