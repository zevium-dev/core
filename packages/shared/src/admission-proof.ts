/** Durable admission attestation. No expiry: delayed outbox retries must settle. */
export type AdmissionClaims = {
  reservationId: string;
  consumerClerkOrgId: string;
  projectId: string;
  /** Immutable spec-version identity is the executing route revision. */
  routeRevision: string;
  policyRevision: number;
  mode: "open" | "entitled_only";
  admittedAt: number;
};

const encoder = new TextEncoder();
async function signingKey(secret: string) {
  if (!secret) throw new Error("Admission signing secret is required");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function payload(claims: AdmissionClaims): string {
  return JSON.stringify([
    "zevium-admission-v1",
    claims.reservationId,
    claims.consumerClerkOrgId,
    claims.projectId,
    claims.routeRevision,
    claims.policyRevision,
    claims.mode,
    claims.admittedAt,
  ]);
}
export async function signAdmissionProof(
  secret: string,
  claims: AdmissionClaims,
): Promise<string> {
  const body = payload(claims);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(secret),
      encoder.encode(body),
    ),
  );
  return JSON.stringify({
    claims,
    signature: Array.from(signature, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  });
}
export async function verifyAdmissionProof(
  secret: string,
  proof: string,
  binding: Pick<
    AdmissionClaims,
    "reservationId" | "consumerClerkOrgId" | "projectId" | "routeRevision"
  >,
): Promise<AdmissionClaims | null> {
  try {
    if (proof.length > 4096) return null;
    const parsed: unknown = JSON.parse(proof);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("claims" in parsed) ||
      !("signature" in parsed)
    )
      return null;
    const c = parsed.claims;
    if (!c || typeof c !== "object") return null;
    const claims = c as AdmissionClaims;
    if (
      claims.reservationId !== binding.reservationId ||
      claims.consumerClerkOrgId !== binding.consumerClerkOrgId ||
      claims.projectId !== binding.projectId ||
      claims.routeRevision !== binding.routeRevision ||
      !Number.isSafeInteger(claims.policyRevision) ||
      claims.policyRevision < 1 ||
      !Number.isSafeInteger(claims.admittedAt) ||
      claims.admittedAt < 0 ||
      (claims.mode !== "open" && claims.mode !== "entitled_only") ||
      typeof parsed.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.signature)
    )
      return null;
    const signature = Uint8Array.from(parsed.signature.match(/../g)!, (byte) =>
      parseInt(byte, 16),
    );
    return (await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      signature,
      encoder.encode(payload(claims)),
    ))
      ? claims
      : null;
  } catch {
    return null;
  }
}
