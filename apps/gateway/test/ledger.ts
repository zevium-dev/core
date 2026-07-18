/**
 * Simulated authoritative append-only ledger for tests.
 *
 * Grants are recorded first, then applied to the DO.
 * Settlements are pulled via DO.flush(), appended with settlementId dedupe,
 * then acked (unless dropAck simulates lost ack).
 */

import type {
  FlushResult,
  GrantResult,
  PendingSettlement,
  WalletDO,
} from "../src/wallet";

export type LedgerGrant = {
  grantId: string;
  amount: number;
  recordedAt: number;
};

export type LedgerSettlement = {
  settlementId: string;
  reservationId: string;
  cost: number;
  settledAt: number;
  flushedAt: number;
};

export type WalletStub = DurableObjectStub<WalletDO>;

export class SimulatedLedger {
  grants: LedgerGrant[] = [];
  settlements: LedgerSettlement[] = [];
  #seenSettlements = new Set<string>();
  #sequence = 0;

  get grantsSum(): number {
    return this.grants.reduce((s, g) => s + g.amount, 0);
  }

  get settlementsSum(): number {
    return this.settlements.reduce((s, s0) => s + s0.cost, 0);
  }

  /** ledgerGrantsSum - ledgerSettledSum */
  get net(): number {
    return this.grantsSum - this.settlementsSum;
  }

  /**
   * Authoritative order: record on ledger, then apply to DO.
   * Re-pushing the same grantId records only once on the ledger and relies
   * on DO grant idempotency.
   */
  async pushGrant(
    stub: WalletStub,
    grantId: string,
    amount: number,
  ): Promise<GrantResult> {
    if (!this.grants.some((g) => g.grantId === grantId)) {
      this.grants.push({ grantId, amount, recordedAt: Date.now() });
    }
    return stub.grant(grantId, amount);
  }

  /**
   * Flush pending settlements from DO into the ledger.
   * Dedupes by settlementId. Unless `dropAck`, applies per-reference
   * outcomes with a signed authoritative checkpoint.
   */
  async flushToLedger(
    stub: WalletStub,
    opts: { dropAck?: boolean } = {},
  ): Promise<{
    flush: FlushResult;
    appended: PendingSettlement[];
    acked: boolean;
  }> {
    const flush = await stub.flush();
    const appended: PendingSettlement[] = [];

    const results = flush.settlements.map((settlement) => {
      if (this.#seenSettlements.has(settlement.settlementId)) {
        return {
          refId: settlement.settlementId,
          status: "already_applied" as const,
        };
      }
      this.#seenSettlements.add(settlement.settlementId);
      this.#sequence += 1;
      this.settlements.push({
        settlementId: settlement.settlementId,
        reservationId: settlement.reservationId,
        cost: settlement.cost,
        settledAt: settlement.settledAt,
        flushedAt: Date.now(),
      });
      appended.push(settlement);
      return { refId: settlement.settlementId, status: "applied" as const };
    });

    const acked = !opts.dropAck;
    if (acked && flush.settlements.length > 0) {
      await stub.applySettlementResults(results, {
        clerkOrgId: "simulated-ledger",
        balance: this.net,
        sequence: this.#sequence,
      });
    }

    return { flush, appended, acked };
  }

  /** Drain all pending settlements (with acks) until DO reports empty. */
  async drain(stub: WalletStub, maxRounds = 10): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const { flush } = await this.flushToLedger(stub);
      if (flush.settlements.length === 0) return;
    }
  }
}
