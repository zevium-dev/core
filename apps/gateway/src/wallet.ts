/**
 * Wallet Durable Object — per-org working balance with crash-safe holds.
 *
 * BALANCE MODEL
 * -------------
 * - `balance` is the working balance: grants applied, settled usage already
 *   subtracted (whether or not the settlement has been flushed to the ledger).
 * - `inFlight` holds temporary reservations. Available credit is:
 *     available = balance - sum(inFlight.costs)
 * - reserve: fail if available < cost (or cost <= 0). ZERO balance blocks.
 * - settle: remove from inFlight, balance -= cost, enqueue pending settlement
 *   (atomic). Settlement id is stable: `settle:${reservationId}`.
 * - refund: remove from inFlight only (credit returns to available).
 * - grant: if new grantId, balance += amount, record grantId (idempotent).
 * - flush/ack: flush returns all pending settlements (stable ids). After the
 *   ledger appends them, ack removes them. If ack is lost, re-flush yields the
 *   same settlement ids; the ledger dedupes by settlementId.
 * - free tier: positive wallet balance is required; calls skip reserve/settle,
 *   use per-consumer-operation per-UTC-day counters, and enqueue usage at 0 credits.
 * - alarm (~5s): when pending non-empty, batch → wallets:recordUsage → ack.
 *
 * Crash-safety: multi-key updates go through storage.transaction. State is
 * loaded in the constructor under blockConcurrencyWhile so concurrent
 * requests never see a half-loaded wallet.
 */

import { DurableObject } from "cloudflare:workers";
import {
  ConvexUsageClient,
  pendingToUsageRecord,
  type ConvexUsageRecord,
  type SettlementOutcome,
  type WalletCheckpoint,
} from "./usage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InFlightEntry = {
  cost: number;
  createdAt: number;
  /** Physical key retained for audit/debug compatibility. */
  keyId?: string;
  /** Stable across rotations so one cap cannot be reset by replacing a key. */
  familyId?: string;
};

/** Usage metadata required to flush a settlement to Convex. */
export type SettlementUsage = {
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — the org whose wallet actually pays. */
  consumerClerkOrgId: string;
  projectId: string;
  endpoint: string;
  method: string;
  status: number;
  latencyMs: number;
  keyId: string;
};

export type PendingSettlement = {
  settlementId: string;
  reservationId: string;
  cost: number;
  settledAt: number;
  /** Present for production flush path; unit tests may omit. */
  usage?: SettlementUsage;
};

/** Terminal outcome of a reservation once it leaves inFlight. */
export type TerminalStatus = "settled" | "refunded" | "free";

export type WalletState = {
  balance: number;
  /** Last accepted Convex wallet checkpoint sequence, or -1 before sync. */
  sequence: number;
  inFlightTotal: number;
  inFlight: Record<string, InFlightEntry>;
  appliedGrantIds: string[];
  pendingSettlements: PendingSettlement[];
  available: number;
};

export type GrantResult =
  | { status: "applied"; balance: number }
  | { status: "duplicate"; balance: number }
  | { status: "rejected"; reason: string };

export type ReserveResult =
  | { status: "reserved"; available: number }
  | { status: "duplicate"; available: number }
  | { status: "conflict"; reason: string }
  | { status: "insufficient"; available: number; cost: number }
  | { status: "rejected"; reason: string };

export type SettleResult =
  | { status: "settled"; settlementId: string; balance: number }
  | { status: "already_settled"; settlementId: string }
  | { status: "already_refunded" }
  | { status: "already_free" }
  | { status: "unknown" };

export type RefundResult =
  | { status: "refunded"; available: number }
  | { status: "already_refunded" }
  | { status: "already_settled"; settlementId: string }
  | { status: "already_free" }
  | { status: "unknown" };

export type FreeTierResult =
  | { status: "consumed"; used: number; limit: number }
  | { status: "exhausted"; used: number; limit: number }
  | {
      status: "rejected";
      reason: string;
      available?: number;
    };

export type KeyAuthorizationResult =
  | { status: "allowed" }
  | {
      status: "rejected";
      reason: "key_disabled" | "key_untracked" | "insufficient_credits";
      available?: number;
    };

export type EnqueueFreeResult =
  | { status: "enqueued"; settlementId: string }
  | { status: "duplicate"; settlementId: string }
  | { status: "rejected"; reason: string };

export type FlushResult = {
  batchId: string;
  settlements: PendingSettlement[];
};

export type AckFlushResult = {
  removed: number;
  remaining: number;
};

export type FlushToConvexResult = {
  flushed: number;
  acked: number;
  remaining: number;
  error?: string;
};
export type SyncGrantsResult =
  | { status: "ok"; balance: number; sequence: number }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "sync_failed"; error: string; balance: number; sequence: number };

/** Per-key control metadata mirrored from the control-plane keySettings table. */
export type KeySetting = {
  keyId: string;
  /** Stable budget identity inherited by every replacement key. */
  familyId: string;
  /** Absent = unlimited. */
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  /** Old rotated key works until this ms epoch; past = treated as disabled. */
  graceUntil?: number;
};

/** Optional key-context for a reservation (key enforcement). */
export type ReserveOptions = {
  keyId?: string;
  /** Clerk org id owning this wallet — used for lazy settings refresh. */
  clerkOrgId?: string;
  nowMs?: number;
};

// Storage keys
const K_BALANCE = "balance";
const K_SEQUENCE = "authoritativeSequence";
const K_IN_FLIGHT = "inFlight";
const K_APPLIED_GRANTS = "appliedGrantIds";
const K_PENDING = "pendingSettlements";
const K_TERMINAL = "terminalReservations";
const K_FLUSH_SEQ = "flushSeq";
const K_FREE_PREFIX = "free:";
const K_KEY_SETTINGS = "keySettings";
const K_KEY_SETTINGS_AT = "keySettingsSyncedAt";
const K_SETTLED_PREFIX = "settled:";
const K_SYNC_GRANTS_AT = "syncGrantsAt";
const SYNC_GRANTS_WINDOW_MS = 60_000;

const FLUSH_ALARM_MS = 5_000;

function settlementIdFor(reservationId: string): string {
  return `settle:${reservationId}`;
}

function sumInFlight(inFlight: Record<string, InFlightEntry>): number {
  let total = 0;
  for (const entry of Object.values(inFlight)) {
    total += entry.cost;
  }
  return total;
}

function sumInFlightForKey(
  inFlight: Record<string, InFlightEntry>,
  familyId: string,
): number {
  let total = 0;
  for (const entry of Object.values(inFlight)) {
    if ((entry.familyId ?? entry.keyId) === familyId) total += entry.cost;
  }
  return total;
}

function sumPendingCosts(pendingSettlements: PendingSettlement[]): number {
  let total = 0;
  for (const settlement of pendingSettlements) total += settlement.cost;
  return total;
}

/** UTC calendar day key YYYY-MM-DD. */
export function utcDayKey(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function freeStorageKey(
  consumerOrgId: string,
  projectId: string,
  method: string,
  pathTemplate: string,
  day: string,
): string {
  return `${K_FREE_PREFIX}${encodeURIComponent(consumerOrgId)}:${encodeURIComponent(projectId)}:${method.toUpperCase()}:${encodeURIComponent(pathTemplate)}:${day}`;
}

/** UTC calendar month key YYYY-MM. */
export function utcMonthKey(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function settledStorageKey(familyId: string, month: string): string {
  return `${K_SETTLED_PREFIX}${familyId}:${month}`;
}

/** Parse a keySettings array from the /wallet-grants JSON payload. */
function parseKeySettings(raw: unknown): KeySetting[] {
  if (!Array.isArray(raw)) return [];
  const out: KeySetting[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.keyId !== "string" || r.keyId.length === 0) continue;
    if (typeof r.disabled !== "boolean") continue;
    const setting: KeySetting = {
      keyId: r.keyId,
      familyId:
        typeof r.familyId === "string" && r.familyId.length > 0
          ? r.familyId
          : r.keyId,
      disabled: r.disabled,
    };
    if (typeof r.monthlyCapCredits === "number") {
      setting.monthlyCapCredits = r.monthlyCapCredits;
    }
    if (typeof r.rotatedFromKeyId === "string") {
      setting.rotatedFromKeyId = r.rotatedFromKeyId;
    }
    if (typeof r.graceUntil === "number") {
      setting.graceUntil = r.graceUntil;
    }
    out.push(setting);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WalletDO
// ---------------------------------------------------------------------------

export class WalletDO extends DurableObject<Cloudflare.Env> {
  #balance = 0;
  #sequence = -1;
  #inFlight: Record<string, InFlightEntry> = {};
  #appliedGrantIds: Set<string> = new Set();
  #pendingSettlements: PendingSettlement[] = [];
  #terminal: Record<string, TerminalStatus> = {};
  #keySettings: Map<string, KeySetting> = new Map();
  #keySettingsSyncedAt = 0;
  #syncInFlight: Promise<SyncGrantsResult> | null = null;
  #flushSeq = 0;
  #loaded = false;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Block concurrent requests until state is fully loaded from storage.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.#load();
    });
  }
  async #load(): Promise<void> {
    const stored = await this.ctx.storage.get<
      | number
      | Record<string, InFlightEntry>
      | string[]
      | PendingSettlement[]
      | Record<string, TerminalStatus>
      | Record<string, KeySetting>
    >([
      K_BALANCE,
      K_SEQUENCE,
      K_IN_FLIGHT,
      K_APPLIED_GRANTS,
      K_PENDING,
      K_TERMINAL,
      K_FLUSH_SEQ,
      K_KEY_SETTINGS,
      K_KEY_SETTINGS_AT,
    ]);

    this.#balance = (stored.get(K_BALANCE) as number | undefined) ?? 0;
    this.#sequence = (stored.get(K_SEQUENCE) as number | undefined) ?? -1;
    this.#inFlight =
      (stored.get(K_IN_FLIGHT) as Record<string, InFlightEntry> | undefined) ??
      {};
    const grants = (stored.get(K_APPLIED_GRANTS) as string[] | undefined) ?? [];
    this.#appliedGrantIds = new Set(grants);
    this.#pendingSettlements =
      (stored.get(K_PENDING) as PendingSettlement[] | undefined) ?? [];
    this.#terminal =
      (stored.get(K_TERMINAL) as Record<string, TerminalStatus> | undefined) ??
      {};
    this.#flushSeq = (stored.get(K_FLUSH_SEQ) as number | undefined) ?? 0;
    const settingsMap =
      (stored.get(K_KEY_SETTINGS) as Record<string, KeySetting> | undefined) ??
      {};
    this.#keySettings = new Map(Object.entries(settingsMap));
    this.#keySettingsSyncedAt =
      (stored.get(K_KEY_SETTINGS_AT) as number | undefined) ?? 0;
    this.#loaded = true;
  }

  #available(): number {
    return Math.max(0, this.#balance - sumInFlight(this.#inFlight));
  }

  #snapshot(): WalletState {
    const inFlightTotal = sumInFlight(this.#inFlight);
    return {
      balance: this.#balance,
      sequence: this.#sequence,
      inFlightTotal,
      inFlight: { ...this.#inFlight },
      appliedGrantIds: [...this.#appliedGrantIds],
      pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
      available: Math.max(0, this.#balance - inFlightTotal),
    };
  }

  /**
   * Serialize read-modify-write transitions inside the DO even across awaits.
   * Storage transactions protect persistence; this lock keeps the in-memory
   * projection and cap checks coherent with the committed transaction.
   */
  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #persist(
    keys: Partial<{
      balance: number;
      sequence: number;
      inFlight: Record<string, InFlightEntry>;
      appliedGrantIds: string[];
      pendingSettlements: PendingSettlement[];
      terminal: Record<string, TerminalStatus>;
      flushSeq: number;
      keySettings: Record<string, KeySetting>;
      keySettingsSyncedAt: number;
      settledCounter: { storageKey: string; amount: number };
    }>,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      if (keys.balance !== undefined) await txn.put(K_BALANCE, keys.balance);
      if (keys.sequence !== undefined) await txn.put(K_SEQUENCE, keys.sequence);
      if (keys.inFlight !== undefined)
        await txn.put(K_IN_FLIGHT, keys.inFlight);
      if (keys.appliedGrantIds !== undefined)
        await txn.put(K_APPLIED_GRANTS, keys.appliedGrantIds);
      if (keys.pendingSettlements !== undefined)
        await txn.put(K_PENDING, keys.pendingSettlements);
      if (keys.terminal !== undefined) await txn.put(K_TERMINAL, keys.terminal);
      if (keys.flushSeq !== undefined)
        await txn.put(K_FLUSH_SEQ, keys.flushSeq);
      if (keys.keySettings !== undefined)
        await txn.put(K_KEY_SETTINGS, keys.keySettings);
      if (keys.keySettingsSyncedAt !== undefined)
        await txn.put(K_KEY_SETTINGS_AT, keys.keySettingsSyncedAt);
      if (keys.settledCounter !== undefined) {
        const current =
          (await txn.get<number>(keys.settledCounter.storageKey)) ?? 0;
        await txn.put(
          keys.settledCounter.storageKey,
          current + keys.settledCounter.amount,
        );
      }
    });
  }

  async #scheduleFlushAlarm(): Promise<void> {
    if (this.#pendingSettlements.length === 0) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing !== undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
  }

  // -------------------------------------------------------------------------
  // RPC operations
  // -------------------------------------------------------------------------

  async grant(grantId: string, amount: number): Promise<GrantResult> {
    if (!grantId || typeof grantId !== "string") {
      return { status: "rejected", reason: "grantId required" };
    }
    if (!(amount > 0) || !Number.isFinite(amount)) {
      return { status: "rejected", reason: "amount must be > 0" };
    }

    return this.#mutate(async () => {
      if (this.#appliedGrantIds.has(grantId)) {
        return { status: "duplicate", balance: this.#balance };
      }

      this.#appliedGrantIds.add(grantId);
      this.#balance += amount;

      await this.#persist({
        balance: this.#balance,
        appliedGrantIds: [...this.#appliedGrantIds],
      });

      return { status: "applied", balance: this.#balance };
    });
  }

  async reserve(
    reservationId: string,
    cost: number,
    opts: ReserveOptions = {},
  ): Promise<ReserveResult> {
    if (!reservationId || typeof reservationId !== "string") {
      return { status: "rejected", reason: "reservationId required" };
    }
    if (!(cost > 0) || !Number.isFinite(cost)) {
      return { status: "rejected", reason: "cost must be > 0" };
    }

    const now = opts.nowMs ?? Date.now();
    const setting = opts.keyId
      ? await this.#resolveKeySetting(opts.keyId, opts.clerkOrgId, now)
      : null;

    return this.#mutate(async () => {
      const existing = this.#inFlight[reservationId];
      if (existing) {
        if (existing.cost === cost) {
          return { status: "duplicate", available: this.#available() };
        }
        return {
          status: "conflict",
          reason: `reservation ${reservationId} already held at cost ${existing.cost}`,
        };
      }

      const terminal = this.#terminal[reservationId];
      if (terminal) {
        return {
          status: "conflict",
          reason: `reservation ${reservationId} already ${terminal}`,
        };
      }

      // Per-key enforcement: disabled, expired grace, and all active holds.
      const currentSetting = opts.keyId
        ? setting === undefined
          ? null
          : (this.#keySettings.get(opts.keyId) ?? setting)
        : null;
      if (opts.keyId && currentSetting === null) {
        return { status: "rejected", reason: "key_untracked" };
      }
      if (opts.keyId && currentSetting) {
        if (this.#isKeyDisabled(currentSetting, now)) {
          return { status: "rejected", reason: "key_disabled" };
        }
        if (currentSetting.monthlyCapCredits !== undefined) {
          const month = utcMonthKey(now);
          const familyId = currentSetting.familyId ?? currentSetting.keyId;
          const used =
            (await this.ctx.storage.get<number>(
              settledStorageKey(familyId, month),
            )) ?? 0;
          const reserved = sumInFlightForKey(this.#inFlight, familyId);
          if (used + reserved + cost > currentSetting.monthlyCapCredits) {
            return { status: "rejected", reason: "key_cap_exceeded" };
          }
        }
      }

      const available = this.#available();
      if (available < cost) {
        return { status: "insufficient", available, cost };
      }

      this.#inFlight[reservationId] = {
        cost,
        createdAt: Date.now(),
        ...(opts.keyId
          ? {
              keyId: opts.keyId,
              familyId:
                currentSetting?.familyId ?? currentSetting?.keyId ?? opts.keyId,
            }
          : {}),
      };
      await this.#persist({ inFlight: { ...this.#inFlight } });

      return { status: "reserved", available: this.#available() };
    });
  }

  async settle(
    reservationId: string,
    usage?: SettlementUsage,
  ): Promise<SettleResult> {
    if (!reservationId) return { status: "unknown" };

    return this.#mutate(async () => {
      const terminal = this.#terminal[reservationId];
      if (terminal === "settled") {
        return {
          status: "already_settled",
          settlementId: settlementIdFor(reservationId),
        };
      }
      if (terminal === "refunded") {
        return { status: "already_refunded" };
      }
      if (terminal === "free") {
        return { status: "already_free" };
      }

      const entry = this.#inFlight[reservationId];
      if (!entry) {
        return { status: "unknown" };
      }

      const settlementId = settlementIdFor(reservationId);
      const settledAt = Date.now();
      const { cost } = entry;

      delete this.#inFlight[reservationId];
      this.#balance -= cost;
      this.#terminal[reservationId] = "settled";
      const pending: PendingSettlement = {
        settlementId,
        reservationId,
        cost,
        settledAt,
      };
      if (usage) pending.usage = usage;
      this.#pendingSettlements.push(pending);

      await this.#persist({
        balance: this.#balance,
        inFlight: { ...this.#inFlight },
        pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
        terminal: { ...this.#terminal },
        ...((entry.familyId ?? entry.keyId ?? usage?.keyId) && cost > 0
          ? {
              settledCounter: {
                storageKey: settledStorageKey(
                  entry.familyId ?? entry.keyId ?? usage!.keyId,
                  utcMonthKey(settledAt),
                ),
                amount: cost,
              },
            }
          : {}),
      });
      await this.#scheduleFlushAlarm();

      return { status: "settled", settlementId, balance: this.#balance };
    });
  }

  async refund(reservationId: string): Promise<RefundResult> {
    if (!reservationId) return { status: "unknown" };

    return this.#mutate(async () => {
      const terminal = this.#terminal[reservationId];
      if (terminal === "refunded") {
        return { status: "already_refunded" };
      }
      if (terminal === "settled") {
        return {
          status: "already_settled",
          settlementId: settlementIdFor(reservationId),
        };
      }
      if (terminal === "free") {
        return { status: "already_free" };
      }

      const entry = this.#inFlight[reservationId];
      if (!entry) {
        return { status: "unknown" };
      }

      delete this.#inFlight[reservationId];
      this.#terminal[reservationId] = "refunded";

      await this.#persist({
        inFlight: { ...this.#inFlight },
        terminal: { ...this.#terminal },
      });

      return { status: "refunded", available: this.#available() };
    });
  }

  /**
   * Consume one free-tier unit for a consumer/project/operation on the current UTC day.
   * Does not touch balance / inFlight.
   */
  async consumeFreeTier(
    limit: number,
    opts: {
      keyId: string;
      clerkOrgId: string;
      projectId: string;
      method: string;
      pathTemplate: string;
      nowMs?: number;
    },
  ): Promise<FreeTierResult> {
    if (!(limit > 0) || !Number.isFinite(limit)) {
      return { status: "rejected", reason: "limit must be > 0" };
    }

    const nowMs = opts.nowMs ?? Date.now();
    const setting = await this.#resolveKeySetting(
      opts.keyId,
      opts.clerkOrgId,
      nowMs,
    );

    return this.#mutate(async () => {
      const currentSetting =
        setting === undefined
          ? null
          : (this.#keySettings.get(opts.keyId) ?? setting);
      if (currentSetting === null) {
        return { status: "rejected", reason: "key_untracked" };
      }
      if (this.#isKeyDisabled(currentSetting, nowMs)) {
        return { status: "rejected", reason: "key_disabled" };
      }
      if (this.#balance <= 0) {
        return {
          status: "rejected",
          reason: "insufficient_credits",
          available: this.#available(),
        };
      }
      const day = utcDayKey(nowMs);
      const storageKey = freeStorageKey(
        opts.clerkOrgId,
        opts.projectId,
        opts.method,
        opts.pathTemplate,
        day,
      );
      const used = (await this.ctx.storage.get<number>(storageKey)) ?? 0;
      if (used >= limit) {
        return { status: "exhausted", used, limit };
      }

      const next = used + 1;
      await this.ctx.storage.put(storageKey, next);
      return { status: "consumed", used: next, limit };
    });
  }

  /** Apply current key controls without reserving credits or quota. */
  async authorizeKey(
    keyId: string,
    clerkOrgId: string,
    nowMs: number = Date.now(),
  ): Promise<KeyAuthorizationResult> {
    const setting = await this.#resolveKeySetting(keyId, clerkOrgId, nowMs);
    return this.#mutate(async () => {
      const currentSetting =
        setting === undefined
          ? null
          : (this.#keySettings.get(keyId) ?? setting);
      if (currentSetting === null) {
        return { status: "rejected", reason: "key_untracked" };
      }
      if (this.#isKeyDisabled(currentSetting, nowMs)) {
        return { status: "rejected", reason: "key_disabled" };
      }
      if (this.#balance <= 0) {
        return {
          status: "rejected",
          reason: "insufficient_credits",
          available: this.#available(),
        };
      }
      return { status: "allowed" };
    });
  }

  /** Return a consumed free-tier unit after upstream failure or non-2xx. */
  async refundFreeTier(opts: {
    clerkOrgId: string;
    projectId: string;
    method: string;
    pathTemplate: string;
    nowMs?: number;
  }): Promise<void> {
    await this.#mutate(async () => {
      const storageKey = freeStorageKey(
        opts.clerkOrgId,
        opts.projectId,
        opts.method,
        opts.pathTemplate,
        utcDayKey(opts.nowMs ?? Date.now()),
      );
      const used = (await this.ctx.storage.get<number>(storageKey)) ?? 0;
      if (used > 0) await this.ctx.storage.put(storageKey, used - 1);
    });
  }

  /**
   * Enqueue a free-tier usage row (credits 0) for Convex flush.
   * Marks reservation terminal=free for idempotency.
   */
  async enqueueFreeUsage(
    reservationId: string,
    usage: SettlementUsage,
  ): Promise<EnqueueFreeResult> {
    if (!reservationId || typeof reservationId !== "string") {
      return { status: "rejected", reason: "reservationId required" };
    }

    return this.#mutate(async () => {
      const settlementId = settlementIdFor(reservationId);
      const terminal = this.#terminal[reservationId];
      if (terminal === "free" || terminal === "settled") {
        return { status: "duplicate", settlementId };
      }
      if (terminal === "refunded") {
        return { status: "rejected", reason: "already refunded" };
      }
      if (this.#inFlight[reservationId]) {
        return { status: "rejected", reason: "reservation in flight" };
      }

      const settledAt = Date.now();
      this.#terminal[reservationId] = "free";
      this.#pendingSettlements.push({
        settlementId,
        reservationId,
        cost: 0,
        settledAt,
        usage,
      });

      await this.#persist({
        pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
        terminal: { ...this.#terminal },
      });
      await this.#scheduleFlushAlarm();

      return { status: "enqueued", settlementId };
    });
  }

  async flush(): Promise<FlushResult> {
    return this.#mutate(async () => {
      this.#flushSeq += 1;
      await this.#persist({ flushSeq: this.#flushSeq });

      return {
        batchId: `batch:${this.#flushSeq}`,
        settlements: this.#pendingSettlements.map((s) => ({ ...s })),
      };
    });
  }

  /**
   * Persist ledger acknowledgements. Rejected outcomes intentionally remain
   * pending so the alarm retries them; a lost acknowledgement is retried
   * with the same settle:{reservationId} reference.
   */
  async applySettlementResults(
    results: SettlementOutcome[],
    checkpoint: WalletCheckpoint,
  ): Promise<AckFlushResult> {
    return this.#mutate(async () => {
      const removable = new Set(
        results
          .filter(
            (result) =>
              result.status === "applied" ||
              result.status === "already_applied",
          )
          .map((result) => result.refId),
      );
      const before = this.#pendingSettlements.length;
      if (removable.size > 0) {
        this.#pendingSettlements = this.#pendingSettlements.filter(
          (settlement) => !removable.has(settlement.settlementId),
        );
      }
      const removed = before - this.#pendingSettlements.length;

      const checkpointAccepted = this.#acceptCheckpoint(checkpoint);
      if (removed > 0 || checkpointAccepted) {
        await this.#persist({
          balance: this.#balance,
          sequence: this.#sequence,
          pendingSettlements: this.#pendingSettlements.map((settlement) => ({
            ...settlement,
          })),
        });
      }

      return { removed, remaining: this.#pendingSettlements.length };
    });
  }

  /**
   * Flush pending settlements that have usage metadata to Convex, then ack.
   * Rows without usage are left for the SimulatedLedger-style test path.
   */
  async flushToConvex(): Promise<FlushToConvexResult> {
    if (this.#pendingSettlements.length === 0) {
      return { flushed: 0, acked: 0, remaining: 0 };
    }

    const flushable = await this.#mutate(async () =>
      this.#pendingSettlements
        .filter((settlement) => settlement.usage !== undefined)
        .map((settlement) => ({ ...settlement })),
    );
    if (flushable.length === 0) {
      return {
        flushed: 0,
        acked: 0,
        remaining: this.#pendingSettlements.length,
      };
    }

    const events: ConvexUsageRecord[] = [];
    for (const s of flushable) {
      const usage = s.usage;
      if (!usage) continue;
      events.push(
        pendingToUsageRecord({
          settlementId: s.settlementId,
          cost: s.cost,
          settledAt: s.settledAt,
          organizationId: usage.organizationId,
          consumerClerkOrgId: usage.consumerClerkOrgId,
          projectId: usage.projectId,
          endpoint: usage.endpoint,
          method: usage.method,
          status: usage.status,
          latencyMs: usage.latencyMs,
          keyId: usage.keyId,
        }),
      );
    }

    const client = this.#buildUsageClient();
    if (!client) {
      return {
        flushed: 0,
        acked: 0,
        remaining: this.#pendingSettlements.length,
        error: "convex client not configured",
      };
    }

    const usageResult = await client.recordUsage(events).then(
      (r) => ({ ok: true as const, value: r }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    if (!usageResult.ok) {
      const message =
        usageResult.err instanceof Error
          ? usageResult.err.message
          : String(usageResult.err);
      return {
        flushed: 0,
        acked: 0,
        remaining: this.#pendingSettlements.length,
        error: message,
      };
    }

    const ack = await this.applySettlementResults(
      usageResult.value.results,
      usageResult.value.wallet,
    );
    return {
      flushed: events.length,
      acked: ack.removed,
      remaining: ack.remaining,
    };
  }

  #buildUsageClient(): ConvexUsageClient | null {
    // Test hook: module-level mutation override.
    const testFn = getTestUsageMutation();
    if (testFn) {
      return new ConvexUsageClient({
        convexUrl: "https://test.invalid",
        mutationFn: testFn,
      });
    }

    const env = this.env as Cloudflare.Env;
    const url = env.CONVEX_URL;
    if (!url) return null;

    const secret = env.GATEWAY_INTERNAL_SECRET;
    if (secret) {
      const siteBase = (
        env.CONVEX_SITE_URL ?? url.replace(".convex.cloud", ".convex.site")
      ).replace(/\/+$/, "");
      return new ConvexUsageClient({
        convexUrl: url,
        ingestUrl: `${siteBase}/ingest-usage`,
        internalSecret: secret,
      });
    }

    return new ConvexUsageClient({
      convexUrl: url,
      adminKey: env.CONVEX_DEPLOY_KEY,
    });
  }

  async getState(): Promise<WalletState> {
    return this.#snapshot();
  }

  async getFreeTierUsed(opts: {
    clerkOrgId: string;
    projectId: string;
    method: string;
    pathTemplate: string;
    nowMs?: number;
  }): Promise<number> {
    const day = utcDayKey(opts.nowMs ?? Date.now());
    return (
      (await this.ctx.storage.get<number>(
        freeStorageKey(
          opts.clerkOrgId,
          opts.projectId,
          opts.method,
          opts.pathTemplate,
          day,
        ),
      )) ?? 0
    );
  }

  /**
   * Pull the authoritative ledger checkpoint and complete key controls from
   * the control plane. A newer sequence replaces the local projection while
   * retaining active holds and unacknowledged usage as local deductions.
   */
  async syncGrants(
    clerkOrgId: string,
    nowMs: number = Date.now(),
  ): Promise<SyncGrantsResult> {
    return this.#mutate(async () => {
      const last = (await this.ctx.storage.get<number>(K_SYNC_GRANTS_AT)) ?? 0;
      if (nowMs - last < SYNC_GRANTS_WINDOW_MS) {
        return {
          status: "rate_limited",
          retryAfterSeconds: Math.ceil(
            (SYNC_GRANTS_WINDOW_MS - (nowMs - last)) / 1000,
          ),
        };
      }
      // Claim the window before the network call so a flood of retries is gated.
      await this.ctx.storage.put(K_SYNC_GRANTS_AT, nowMs);

      const synced = await this.#fetchGrantsFromConvex(clerkOrgId);
      if (synced === null) {
        return {
          status: "sync_failed",
          error: "could not fetch wallet checkpoint",
          balance: this.#balance,
          sequence: this.#sequence,
        };
      }

      // Full replace: Convex returns the complete key configuration.
      this.#keySettings = new Map(
        synced.keySettings.map((setting) => [setting.keyId, setting]),
      );
      this.#keySettingsSyncedAt = nowMs;
      this.#acceptCheckpoint(synced.wallet);

      await this.#persist({
        balance: this.#balance,
        sequence: this.#sequence,
        keySettings: Object.fromEntries(this.#keySettings),
        keySettingsSyncedAt: this.#keySettingsSyncedAt,
      });

      return {
        status: "ok",
        balance: this.#balance,
        sequence: this.#sequence,
      };
    });
  }

  /**
   * Resolve key settings. Cached settings are refreshed at the bounded
   * freshness interval even for known keys, so disable/rotation changes
   * cannot remain indefinitely stale. Concurrent refreshes share one fetch.
   */
  async #resolveKeySetting(
    keyId: string,
    clerkOrgId: string | undefined,
    nowMs: number,
  ): Promise<KeySetting | null | undefined> {
    if (!clerkOrgId) return undefined;
    if (nowMs - this.#keySettingsSyncedAt >= SYNC_GRANTS_WINDOW_MS) {
      await this.#syncGrantsSingleFlight(clerkOrgId, nowMs);
      // Once positive control state expires, a failed refresh cannot preserve
      // spending authority indefinitely. Missing row then fails closed.
      if (nowMs - this.#keySettingsSyncedAt >= SYNC_GRANTS_WINDOW_MS) {
        return undefined;
      }
    }
    return this.#keySettings.get(keyId) ?? null;
  }

  #isKeyDisabled(setting: KeySetting, nowMs: number): boolean {
    return (
      setting.disabled ||
      (setting.graceUntil !== undefined && nowMs >= setting.graceUntil)
    );
  }

  /**
   * Accept a strictly newer ledger projection. Pending local settlements are
   * deducted from its signed balance until their per-reference outcome is
   * acknowledged; reservations remain represented in #inFlight.
   */
  #acceptCheckpoint(checkpoint: WalletCheckpoint): boolean {
    if (checkpoint.sequence <= this.#sequence) return false;
    this.#sequence = checkpoint.sequence;
    this.#balance =
      checkpoint.balance - sumPendingCosts(this.#pendingSettlements);
    return true;
  }

  /** Coalesce concurrent syncGrants calls into a single fetch. */
  #syncGrantsSingleFlight(
    clerkOrgId: string,
    nowMs: number,
  ): Promise<SyncGrantsResult> {
    if (this.#syncInFlight) return this.#syncInFlight;
    this.#syncInFlight = this.syncGrants(clerkOrgId, nowMs).finally(() => {
      this.#syncInFlight = null;
    });
    return this.#syncInFlight;
  }

  /**
   * Fetch the authoritative wallet checkpoint from Convex /wallet-grants.
   * Returns null on any failure (misconfig, non-2xx, bad JSON) so callers
   * degrade gracefully. Test hook overrides the network path entirely.
   */
  async #fetchGrantsFromConvex(clerkOrgId: string): Promise<{
    wallet: WalletCheckpoint;
    keySettings: KeySetting[];
  } | null> {
    const testFn = getTestGrantsFetcher();
    if (testFn) {
      const r = await testFn(clerkOrgId);
      if (r === null) return null;
      return { ...r, keySettings: r.keySettings ?? [] };
    }

    const env = this.env as Cloudflare.Env;
    const secret = env.GATEWAY_INTERNAL_SECRET;
    const url = env.CONVEX_URL;
    if (!secret || !url) return null;

    const siteBase = (
      env.CONVEX_SITE_URL ?? url.replace(".convex.cloud", ".convex.site")
    ).replace(/\/+$/, "");
    const target = `${siteBase}/wallet-grants?clerkOrgId=${encodeURIComponent(clerkOrgId)}`;

    try {
      const res = await fetch(target, {
        headers: { "x-internal-secret": secret },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        wallet?: unknown;
        keySettings?: unknown;
      };
      if (!json.wallet || typeof json.wallet !== "object") return null;
      const rawWallet = json.wallet as Record<string, unknown>;
      if (
        rawWallet.clerkOrgId !== clerkOrgId ||
        typeof rawWallet.balance !== "number" ||
        !Number.isFinite(rawWallet.balance) ||
        typeof rawWallet.sequence !== "number" ||
        !Number.isSafeInteger(rawWallet.sequence) ||
        rawWallet.sequence < 0
      ) {
        return null;
      }
      const keySettings = parseKeySettings(json.keySettings);
      return {
        wallet: {
          clerkOrgId,
          balance: rawWallet.balance,
          sequence: rawWallet.sequence,
        },
        keySettings,
      };
    } catch {
      return null;
    }
  }

  /**
   * Alarm: batch-flush pending usage to Convex when configured.
   * Re-arms while pending remains.
   */
  async alarm(): Promise<void> {
    if (this.#pendingSettlements.length === 0) return;

    const hasUsage = this.#pendingSettlements.some(
      (s) => s.usage !== undefined,
    );
    if (hasUsage) {
      await this.flushToConvex();
    }

    if (this.#pendingSettlements.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Test hook for DO → Convex flush without network
// ---------------------------------------------------------------------------

type TestUsageMutation = (
  name: string,
  args: { events: ConvexUsageRecord[] },
) => Promise<{
  results: SettlementOutcome[];
  wallet: WalletCheckpoint;
}>;

let testUsageMutation: TestUsageMutation | null = null;

export function __setTestUsageMutation(fn: TestUsageMutation | null): void {
  testUsageMutation = fn;
}

function getTestUsageMutation(): TestUsageMutation | null {
  return testUsageMutation;
}

type TestGrantsFetcher = (clerkOrgId: string) => Promise<{
  wallet: WalletCheckpoint;
  keySettings?: KeySetting[];
} | null>;

let testGrantsFetcher: TestGrantsFetcher | null = null;

/** Test harness: override the Convex /wallet-grants fetch (no network). */
export function __setTestGrantsFetcher(fn: TestGrantsFetcher | null): void {
  testGrantsFetcher = fn;
}

function getTestGrantsFetcher(): TestGrantsFetcher | null {
  return testGrantsFetcher;
}
