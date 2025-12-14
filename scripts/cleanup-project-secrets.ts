import { db, orm, schema } from "~/db";
import { serverEnv } from "~/env/server";
import {
  DecryptError,
  getSecretKeyId,
  InvalidSecretFormatError,
  reencryptSecret,
  UnknownEncryptionKeyError,
} from "~/lib/server/crypto-secrets";

async function cleanupProjectSecrets(): Promise<void> {
  const primaryKeyId = serverEnv.SECRETS_PRIMARY_KEY_ID;

  const secrets = await db
    .select({ ciphertext: schema.projectSecret.ciphertext, id: schema.projectSecret.id })
    .from(schema.projectSecret);

  let total = 0;
  let alreadyPrimary = 0;
  let reencrypted = 0;
  let invalidFormat = 0;
  let unknownKey = 0;
  let decryptFailed = 0;

  for (const secret of secrets) {
    total++;
    const keyId = getSecretKeyId(secret.ciphertext);

    if (!keyId) {
      invalidFormat++;
      console.warn(`[cleanup-project-secrets] Skipping secret ${secret.id}: invalid format (no keyId prefix)`);
      continue;
    }

    if (keyId === primaryKeyId) {
      alreadyPrimary++;
      continue;
    }

    try {
      const newCiphertext = await reencryptSecret(secret.ciphertext);

      await db
        .update(schema.projectSecret)
        .set({
          ciphertext: newCiphertext,
          updatedAt: new Date(),
        })
        .where(orm.eq(schema.projectSecret.id, secret.id));

      reencrypted++;
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);

      if (InvalidSecretFormatError.match(error)) {
        invalidFormat++;
        console.warn(`[cleanup-project-secrets] Invalid format for secret ${secret.id}:`, message);
        continue;
      }

      if (UnknownEncryptionKeyError.match(error)) {
        unknownKey++;
        console.warn(`[cleanup-project-secrets] Unknown key for secret ${secret.id}:`, message);
        continue;
      }

      if (DecryptError.match(error)) {
        decryptFailed++;
        console.warn(`[cleanup-project-secrets] Decryption failed for secret ${secret.id}:`, message);
        continue;
      }

      console.error(
        `[cleanup-project-secrets] Unexpected error for secret ${secret.id}:`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    }
  }

  console.log("[cleanup-project-secrets] Summary", {
    alreadyPrimary,
    decryptFailed,
    invalidFormat,
    reencrypted,
    total,
    unknownKey,
  });
}

// Run immediately when executed as a script
void cleanupProjectSecrets().catch((error) => {
  console.error(
    "[cleanup-project-secrets] Fatal error:",
    error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error),
  );
  process.exit(1);
});
