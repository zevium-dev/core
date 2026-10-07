/** Partition provider retry labels when publisher accounts serve many consumers. */
export async function scopeUpstreamIdempotencyKey(
  key: string,
  scope: {
    consumerOrgId: string;
    projectId: string;
    method: string;
    upstreamUrl: string;
  },
): Promise<string> {
  // Tuple encoding keeps caller-controlled labels/URLs from changing field boundaries.
  // Do not include the consumer API key: rotation must preserve the retry namespace.
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "zevium-upstream-idempotency-v1",
      scope.consumerOrgId,
      scope.projectId,
      scope.method.toUpperCase(),
      scope.upstreamUrl,
      key,
    ]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
