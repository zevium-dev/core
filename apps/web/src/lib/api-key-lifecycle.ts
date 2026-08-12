export type RevokeReservation = {
  status: "reserved" | "completed" | "failed";
} | null;

export type RevokeLifecycleDependencies = {
  loadOwnedKey: () => Promise<{ revoked: boolean }>;
  reserveLocalGate: () => Promise<RevokeReservation>;
  revokeExternal: () => Promise<void>;
  completeLocal: () => Promise<void>;
  compensateLocal: (message: string) => Promise<void>;
};

/**
 * Destructive Clerk call is unreachable until ownership verification and local
 * disabled-gate reservation both succeed. Compensation is idempotent server-side.
 */
export async function revokeWithLocalPreflight(
  dependencies: RevokeLifecycleDependencies,
): Promise<void> {
  const key = await dependencies.loadOwnedKey();
  const reservation = await dependencies.reserveLocalGate();
  if (reservation?.status === "completed") return;
  if (reservation?.status !== "reserved") {
    throw new Error("This revocation attempt expired. Start a new one.");
  }
  try {
    if (!key.revoked) await dependencies.revokeExternal();
  } catch (error) {
    await dependencies.compensateLocal("Clerk revocation failed");
    throw error;
  }
  // External revoke is terminal. If completion fails, reservation remains
  // disabled and recoverable; never compensate by re-enabling local gate.
  await dependencies.completeLocal();
}
