/** Hard server and gateway cap for one financial settlement transaction. */
export const MAX_USAGE_INGEST_EVENTS = 25;

export type ReservationProofPayload = {
  consumerClerkOrgId: string;
  reservationId: string;
  credits: number;
  checkpointSequence: number;
  authorizedBalance: number;
  reservedAt: number;
  keyId: string;
};

function proofMessage(payload: ReservationProofPayload): string {
  return [
    "zevium-reservation-v1",
    payload.consumerClerkOrgId,
    payload.reservationId,
    String(payload.credits),
    String(payload.checkpointSequence),
    String(payload.authorizedBalance),
    String(payload.reservedAt),
    payload.keyId,
  ].join("\n");
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function signReservationProof(
  secret: string,
  payload: ReservationProofPayload,
): Promise<string> {
  if (secret.length < 32) {
    throw new Error("Reservation proof secret must contain at least 32 bytes");
  }
  return await hmac(secret, proofMessage(payload));
}

export async function verifyReservationProof(
  secret: string,
  payload: ReservationProofPayload,
  signature: string,
): Promise<boolean> {
  if (secret.length < 32 || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await hmac(secret, proofMessage(payload));
  let mismatch = expected.length ^ signature.length;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ (signature.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export type TransferCorrelationPayload = {
  publisherTransferId: string;
  nonce: string;
  platformAccountId: string;
  destination: string;
  currency: string;
  amount: number;
};

function transferMessage(payload: TransferCorrelationPayload): string {
  return [
    "zevium-transfer-v1",
    payload.publisherTransferId,
    payload.nonce,
    payload.platformAccountId,
    payload.destination,
    payload.currency.toLowerCase(),
    String(payload.amount),
  ].join("\n");
}

export async function signTransferCorrelation(
  secret: string,
  payload: TransferCorrelationPayload,
): Promise<string> {
  if (secret.length < 32) {
    throw new Error(
      "Transfer correlation secret must contain at least 32 bytes",
    );
  }
  return await hmac(secret, transferMessage(payload));
}

export async function verifyTransferCorrelation(
  secret: string,
  payload: TransferCorrelationPayload,
  signature: string,
): Promise<boolean> {
  if (secret.length < 32 || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await hmac(secret, transferMessage(payload));
  let mismatch = expected.length ^ signature.length;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ (signature.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
