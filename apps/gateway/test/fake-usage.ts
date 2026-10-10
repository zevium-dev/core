import type {
  ConvexUsageRecord,
  RecordUsageResult,
  SettlementOutcome,
  WalletCheckpoint,
} from "../src/usage";

/** Test-only fake Convex mutation sink with ack-friendly bookkeeping. */
export class FakeConvexUsageSink {
  readonly batches: ConvexUsageRecord[][] = [];
  readonly records: ConvexUsageRecord[] = [];
  readonly seenSettleRefIds = new Set<string>();
  readonly #wallets = new Map<string, WalletCheckpoint>();
  failNext = false;

  setWallet(clerkOrgId: string, balance: number, sequence: number = 0): void {
    this.#wallets.set(clerkOrgId, { clerkOrgId, balance, sequence });
  }

  async recordUsage(events: ConvexUsageRecord[]): Promise<RecordUsageResult> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("fake convex unavailable"));
    }
    this.batches.push(events.map((e) => ({ ...e })));
    const clerkOrgId = events[0]?.consumerClerkOrgId;
    if (
      !clerkOrgId ||
      events.some((event) => event.consumerClerkOrgId !== clerkOrgId)
    ) {
      return Promise.reject(new Error("mixed consumer wallet batch"));
    }
    const checkpoint = this.#wallets.get(clerkOrgId) ?? {
      clerkOrgId,
      balance: 0,
      sequence: 0,
    };
    const results: SettlementOutcome[] = [];
    for (const e of events) {
      if (this.seenSettleRefIds.has(e.settleRefId)) {
        results.push({ refId: e.settleRefId, status: "already_applied" });
        continue;
      }
      this.seenSettleRefIds.add(e.settleRefId);
      this.records.push({ ...e });
      checkpoint.balance -= e.credits;
      checkpoint.sequence += 1;
      results.push({ refId: e.settleRefId, status: "applied" });
    }
    this.#wallets.set(clerkOrgId, checkpoint);
    return { results, wallet: { ...checkpoint } };
  }

  asMutationFn(): (
    name: string,
    args: { events: ConvexUsageRecord[] },
  ) => Promise<RecordUsageResult> {
    return async (_name, args) => this.recordUsage(args.events);
  }
}
