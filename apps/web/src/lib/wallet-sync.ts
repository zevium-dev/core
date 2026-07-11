/**
 * Fire-and-forget: tell the gateway wallet DO to pull control-plane grants
 * so newly purchased credits become spendable at the edge. Ignored on failure
 * (gateway may be down in dev); the DO reconcile is best-effort, not blocking.
 */
export async function triggerGatewayGrantSync(
  gatewayUrl: string | undefined,
  clerkOrgId: string,
): Promise<void> {
  const base =
    typeof gatewayUrl === "string" && gatewayUrl.trim().length > 0
      ? gatewayUrl.trim().replace(/\/+$/, "")
      : null;
  if (base === null || clerkOrgId.length === 0) return;

  await fetch(`${base}/wallet/${encodeURIComponent(clerkOrgId)}/sync-grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // DO reads clerkOrgId from the body, not the path.
    body: JSON.stringify({ clerkOrgId }),
    // Idempotent pull — no client auth needed; the DO rate-limits per org.
    keepalive: true,
  }).catch(() => {
    // Swallow: gateway optional in dev. Convex ledger remains source of truth.
  });
}
