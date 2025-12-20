import { db, orm, schema } from "~/db";

import { decryptSecret } from "./crypto-secrets";

/**
 * Loads and decrypts a single secret by name for a project.
 * Returns null if the secret doesn't exist or fails to decrypt.
 *
 * @param projectId - The project ID
 * @param secretName - The name of the secret to load
 * @returns The plaintext value, or null if not found/decryption fails
 */
export async function loadProjectSecret(projectId: string, secretName: string): Promise<null | string> {
  const row = await db
    .select({
      ciphertext: schema.projectSecret.ciphertext,
      id: schema.projectSecret.id,
    })
    .from(schema.projectSecret)
    .where(orm.and(orm.eq(schema.projectSecret.projectId, projectId), orm.eq(schema.projectSecret.name, secretName)))
    .limit(1)
    .then((v) => v.at(0));

  if (!row) {
    return null;
  }

  try {
    return await decryptSecret(row.ciphertext);
  } catch (error) {
    console.error(
      `Failed to decrypt secret '${secretName}' (id: ${row.id}):`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Loads and decrypts all secrets for a project.
 * Returns a Record mapping secret names to their plaintext values.
 *
 * This function is SERVER-ONLY and should never be exposed to clients.
 * Use it in server-side code where you need to substitute secrets into
 * API calls, configurations, or templates.
 *
 * @param projectId - The project ID to load secrets for
 * @returns A Record of secret name -> plaintext value
 */
export async function loadProjectSecrets(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({
      ciphertext: schema.projectSecret.ciphertext,
      id: schema.projectSecret.id,
      name: schema.projectSecret.name,
    })
    .from(schema.projectSecret)
    .where(orm.eq(schema.projectSecret.projectId, projectId));

  const result: Record<string, string> = {};

  for (const row of rows) {
    try {
      result[row.name] = await decryptSecret(row.ciphertext);
    } catch (error) {
      // Log error but continue - one bad secret shouldn't break everything
      console.error(
        `Failed to decrypt secret '${row.name}' (id: ${row.id}):`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return result;
}
