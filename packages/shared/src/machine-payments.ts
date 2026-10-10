/** Fixed top-up pack; endpoint prices still come exclusively from the spec. */
export const MACHINE_TOPUP_CREDITS = 10_000;
export const MACHINE_TOPUP_CENTS = 100;
export const MACHINE_TOPUP_ATOMIC_USDC = "1000000";
export const MACHINE_SESSION_SECONDS = 24 * 60 * 60;
export const MAX_MACHINE_LOTS_PER_CALL = 24;
export type MachineAllocation = { sourceRef: string; credits: number };
export type MachineFunding = { admittedAt: number; lots: MachineAllocation[] };
export type MachineGrant = {
  walletId: string;
  sourceRef: string;
  credits: number;
  createdAt: number;
  expiresAt: number;
  applied: boolean;
};
export function machineWalletId(network: string, payer: string): string {
  return `x402:${network}:${payer.toLowerCase()}`;
}
export function fundingExpiresAt(createdAt: number): number {
  const date = new Date(createdAt);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.getTime();
}
export function validMachineFunding(value: unknown): value is MachineFunding {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.admittedAt !== "number" ||
    !Number.isSafeInteger(v.admittedAt) ||
    v.admittedAt <= 0 ||
    !Array.isArray(v.lots) ||
    v.lots.length > MAX_MACHINE_LOTS_PER_CALL
  )
    return false;
  const refs = new Set<string>();
  return v.lots.every((lot: unknown) => {
    if (!lot || typeof lot !== "object") return false;
    const l = lot as Record<string, unknown>;
    if (
      typeof l.sourceRef !== "string" ||
      !/^x402:pi_[A-Za-z0-9]+$/.test(l.sourceRef) ||
      refs.has(l.sourceRef) ||
      typeof l.credits !== "number" ||
      !Number.isSafeInteger(l.credits) ||
      l.credits <= 0
    )
      return false;
    refs.add(l.sourceRef);
    return true;
  });
}
