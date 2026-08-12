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
 * - queue: pending rows live in transactional 100-row storage partitions.
 * - flush/ack: the test ledger can read all stable ids. Production sends one
 *   bounded partition, rotates retryable outcomes, bisects row-scoped batch
 *   failures, and terminally dead-letters only permanent singleton poison.
 *   Lost acknowledgements replay the same ids; the ledger dedupes them.
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
  usageFailureDisposition,
  type ConvexUsageRecord,
  type SettlementOutcome,
  type WalletCheckpoint,
} from "./usage";
import {
  inspectSettlementQueue,
  readSettlementQueue,
  SETTLEMENT_QUEUE_PARTITION_SIZE,
  submitWithPoisonBisection,
  writeSettlementQueue,
  type SettlementQueueLayout,
} from "./settlement-queue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InFlightEntry = {
  cost: number;
  createdAt: number;
  /** Present for keyed reservations so their aggregate is cap-enforced. */
  keyId?: string;
  /** Immutable cap/family facts captured before this reservation. */
  keyBudget?: KeyBudgetSnapshot;
};

export type KeyBudgetSnapshot = {
  keyId: string;
  keyFamilyId: string;
  monthlyCapCredits?: number;
  period: string;
  usedBefore: number;
  reservedBefore: number;
  reservationCredits: number;
};

/** Usage metadata required to flush a settlement to Convex. */
export type SettlementUsage = {
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — the org whose wallet actually pays. */
  consumerClerkOrgId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  endpoint: string;
  method: string;
  listedCostCredits: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision: "listed_price" | "free_tier" | "zero_price";
  status: number;
  latencyMs: number;
  keyId: string;
  billingOutcome: "settled" | "refunded" | "free";
  qualityOutcome: "success" | "client_error" | "server_error" | "network_error";
  keyFamilyId: string;
  monthlyCapCredits?: number;
  budgetPeriod: string;
  budgetUsedBefore: number;
  budgetReservedBefore: number;
  budgetReservationCredits: number;
  /** Origin dispatch happened but no authoritative response was observed. */
  ambiguous?: boolean;
  /** Stable platform-generated key sent to publisher for replay protection. */
  publisherIdempotencyKey?: string;
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

/** Terminal record with completion time so retention pruning is possible. */
export type TerminalRecord = { status: TerminalStatus; at: number };

/** Permanently rejected settlement, parked out of the retry queue. */
export type DeadLetterSettlement = PendingSettlement & {
  reason: string;
  deadAt: number;
};

export type WalletState = {
  balance: number;
  /** Last accepted Convex wallet checkpoint sequence, or -1 before sync. */
  sequence: number;
  inFlightTotal: number;
  inFlight: Record<string, InFlightEntry>;
  appliedGrantIds: string[];
  pendingSettlements: PendingSettlement[];
  available: number;
  deadLetterCount: number;
};

export type GrantResult =
  | { status: "applied"; balance: number }
  | { status: "duplicate"; balance: number }
  | { status: "rejected"; reason: string };

export type ReserveResult =
  | { status: "reserved"; available: number; keyBudget: KeyBudgetSnapshot }
  | { status: "duplicate"; available: number; keyBudget: KeyBudgetSnapshot }
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
  | {
      status: "consumed";
      used: number;
      usedBefore: number;
      limit: number;
      keyBudget: KeyBudgetSnapshot;
    }
  | { status: "exhausted"; used: number; limit: number }
  | {
      status: "rejected";
      reason: string;
      available?: number;
    };

export type KeyAuthorizationResult =
  | { status: "allowed"; keyBudget: KeyBudgetSnapshot }
  | {
      status: "rejected";
      reason: "key_disabled" | "insufficient_credits" | "organization_archived";
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
  rejected: number;
  retryable: number;
  remaining: number;
  /** Permanently rejected settlements parked into the dead-letter queue. */
  deadLettered: number;
};

export type FlushToConvexResult = {
  flushed: number;
  acked: number;
  rejected: number;
  retryable: number;
  blocked: number;
  remaining: number;
  error?: string;
};

export type SettlementDeadLetter = {
  settlement: PendingSettlement;
  reason: string;
  rejectedAt: number;
  terminal: true;
  source: "outcome" | "batch";
};
export type SyncGrantsResult =
  | { status: "ok"; balance: number; sequence: number }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "sync_failed"; error: string; balance: number; sequence: number };

/** Per-key control metadata mirrored from the control-plane keySettings table. */
export type KeySetting = {
  keyId: string;
  keyFamilyId?: string;
  /** Absent = unlimited. */
  monthlyCapCredits?: number;
  disabled: boolean;
  rotatedFromKeyId?: string;
  /** Old rotated key works until this ms epoch; past = treated as disabled. */
  graceUntil?: number;
  rotationRequiredAt?: number;
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
const K_ORG_ARCHIVED = "organizationArchived";
const K_SETTLED_PREFIX = "settled:";
const K_DEAD_LETTER_PREFIX = "dead-letter:";
const K_SYNC_GRANTS_AT = "syncGrantsAt";
const K_DEAD_LETTERS = "deadLetterSettlements";
const K_LAST_COMPACTION_AT = "lastCompactionAt";
const SYNC_GRANTS_WINDOW_MS = 60_000;

const FLUSH_ALARM_MS = 5_000;
/** Reservation lease: execution paths settle/refund in seconds; 10m is generous. */
export const RESERVATION_TTL_MS = 10 * 60_000;
/** Terminal idempotency window; older records are pruned on write. */
export const TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
/** Applied-grant dedupe set cap; Convex ledger dedupes beyond this window. */
export const MAX_APPLIED_GRANTS = 2048;
/** Dead-letter queue cap; oldest dropped past this bound. */
export const MAX_DEAD_LETTERS = 100;
/** Maintenance alarm cadence while reservations are outstanding. */
const MAINTENANCE_ALARM_MS = 60_000;
/** Counter compaction runs at most once per hour. */
const COMPACTION_INTERVAL_MS = 60 * 60_000;
export const USAGE_FLUSH_BATCH_SIZE = SETTLEMENT_QUEUE_PARTITION_SIZE;

function settlementIdFor(reservationId: string): string {
  return `settle:${reservationId}`;
}

function sumInFlight(inFlight: Record<string, InFlightEntry>): number {
  let total = 0;
  for (const entry of Object.values(inFlight)) {
    total += entry.cost;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Wallet hold total exceeds safe integer range");
    }
  }
  return total;
}

function sumInFlightForKey(
  inFlight: Record<string, InFlightEntry>,
  keyId: string,
): number {
  let total = 0;
  for (const entry of Object.values(inFlight)) {
    if (entry.keyId === keyId) total += entry.cost;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Key hold total exceeds safe integer range");
    }
  }
  return total;
}

function sumPendingCosts(pendingSettlements: PendingSettlement[]): number {
  let total = 0;
  for (const settlement of pendingSettlements) {
    total += settlement.cost;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Pending settlement total exceeds safe integer range");
    }
  }
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

function settledStorageKey(keyId: string, month: string): string {
  return `${K_SETTLED_PREFIX}${keyId}:${month}`;
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
    const setting: KeySetting = { keyId: r.keyId, disabled: r.disabled };
    if (typeof r.keyFamilyId === "string" && r.keyFamilyId.length > 0) {
      setting.keyFamilyId = r.keyFamilyId;
    }
    if (typeof r.monthlyCapCredits === "number") {
      setting.monthlyCapCredits = r.monthlyCapCredits;
    }
    if (typeof r.rotatedFromKeyId === "string") {
      setting.rotatedFromKeyId = r.rotatedFromKeyId;
    }
    if (typeof r.graceUntil === "number") {
      setting.graceUntil = r.graceUntil;
    }
    if (typeof r.rotationRequiredAt === "number") {
      setting.rotationRequiredAt = r.rotationRequiredAt;
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
  #terminal: Record<string, TerminalRecord> = {};
  #deadLetters: DeadLetterSettlement[] = [];
  #lastCompactionAt = 0;
  #keySettings: Map<string, KeySetting> = new Map();
  #keySettingsSyncedAt = 0;
  #orgArchived = false;
  #syncInFlight: Promise<SyncGrantsResult> | null = null;
  #flushSeq = 0;
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
      | Record<string, TerminalStatus | TerminalRecord>
      | Record<string, KeySetting>
      | DeadLetterSettlement[]
      | boolean
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
      K_DEAD_LETTERS,
      K_LAST_COMPACTION_AT,
      K_ORG_ARCHIVED,
    ]);

    this.#balance = (stored.get(K_BALANCE) as number | undefined) ?? 0;
    this.#sequence = (stored.get(K_SEQUENCE) as number | undefined) ?? -1;
    this.#inFlight =
      (stored.get(K_IN_FLIGHT) as Record<string, InFlightEntry> | undefined) ??
      {};
    const grants = (stored.get(K_APPLIED_GRANTS) as string[] | undefined) ?? [];
    this.#appliedGrantIds = new Set(grants);
    const partitionedQueue = await readSettlementQueue<PendingSettlement>(
      this.ctx.storage,
    );
    const legacyQueue = stored.get(K_PENDING) as
      PendingSettlement[] | undefined;
    this.#pendingSettlements = partitionedQueue ?? legacyQueue ?? [];
    if (partitionedQueue === null && legacyQueue !== undefined) {
      await this.ctx.storage.transaction(async (txn) => {
        await writeSettlementQueue(txn, legacyQueue);
        await txn.delete(K_PENDING);
      });
    } else if (partitionedQueue !== null && legacyQueue !== undefined) {
      await this.ctx.storage.delete(K_PENDING);
    }
    const rawTerminal =
      (stored.get(K_TERMINAL) as
        Record<string, TerminalStatus | TerminalRecord> | undefined) ?? {};
    // Legacy rows stored a bare status string; normalize to timed records.
    this.#terminal = Object.fromEntries(
      Object.entries(rawTerminal).map(([id, value]) => [
        id,
        typeof value === "string" ? { status: value, at: 0 } : value,
      ]),
    );
    this.#flushSeq = (stored.get(K_FLUSH_SEQ) as number | undefined) ?? 0;
    const settingsMap =
      (stored.get(K_KEY_SETTINGS) as Record<string, KeySetting> | undefined) ??
      {};
    this.#keySettings = new Map(Object.entries(settingsMap));
    this.#keySettingsSyncedAt =
      (stored.get(K_KEY_SETTINGS_AT) as number | undefined) ?? 0;
    this.#deadLetters =
      (stored.get(K_DEAD_LETTERS) as DeadLetterSettlement[] | undefined) ?? [];
    this.#lastCompactionAt =
      (stored.get(K_LAST_COMPACTION_AT) as number | undefined) ?? 0;
    this.#orgArchived =
      (stored.get(K_ORG_ARCHIVED) as boolean | undefined) ?? false;
  }

  #available(): number {
    return Math.max(0, this.#balance - sumInFlight(this.#inFlight));
  }

  /**
   * Lease expiry: reservations whose execution died before settle/refund are
   * refunded after RESERVATION_TTL_MS so credits cannot be held forever. The
   * terminal record keeps late settle/refund calls idempotent.
   */
  #expireStaleReservations(now: number): boolean {
    let changed = false;
    for (const [id, entry] of Object.entries(this.#inFlight)) {
      if (now - entry.createdAt >= RESERVATION_TTL_MS) {
        delete this.#inFlight[id];
        this.#terminal[id] = { status: "refunded", at: now };
        changed = true;
      }
    }
    return changed;
  }

  /** Bound terminal map: drop records past the idempotency retention window. */
  #pruneTerminal(now: number): void {
    for (const [id, record] of Object.entries(this.#terminal)) {
      if (record.at !== 0 && now - record.at >= TERMINAL_RETENTION_MS) {
        delete this.#terminal[id];
      }
    }
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
      deadLetterCount: this.#deadLetters.length,
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
    } catch (error) {
      // Storage transactions can reject after local fields were changed. Reload
      // every projection before releasing the mutation gate.
      await this.#load();
      throw error;
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
      terminal: Record<string, TerminalRecord>;
      flushSeq: number;
      deadLetters: DeadLetterSettlement[];
      lastCompactionAt: number;
      keySettings: Record<string, KeySetting>;
      keySettingsSyncedAt: number;
      organizationArchived: boolean;
      settledCounter: { storageKey: string; amount: number };
      settlementDeadLetters: SettlementDeadLetter[];
    }>,
  ): Promise<void> {
    for (const value of [keys.balance, keys.sequence, keys.flushSeq]) {
      if (value !== undefined && !Number.isSafeInteger(value)) {
        throw new Error("Wallet state exceeds safe integer range");
      }
    }
    await this.ctx.storage.transaction(async (txn) => {
      if (keys.balance !== undefined) await txn.put(K_BALANCE, keys.balance);
      if (keys.sequence !== undefined) await txn.put(K_SEQUENCE, keys.sequence);
      if (keys.inFlight !== undefined)
        await txn.put(K_IN_FLIGHT, keys.inFlight);
      if (keys.appliedGrantIds !== undefined)
        await txn.put(K_APPLIED_GRANTS, keys.appliedGrantIds);
      if (keys.pendingSettlements !== undefined) {
        await writeSettlementQueue(txn, keys.pendingSettlements);
        await txn.delete(K_PENDING);
      }
      if (keys.terminal !== undefined) await txn.put(K_TERMINAL, keys.terminal);
      if (keys.flushSeq !== undefined)
        await txn.put(K_FLUSH_SEQ, keys.flushSeq);
      if (keys.deadLetters !== undefined)
        await txn.put(K_DEAD_LETTERS, keys.deadLetters);
      if (keys.lastCompactionAt !== undefined)
        await txn.put(K_LAST_COMPACTION_AT, keys.lastCompactionAt);
      if (keys.keySettings !== undefined)
        await txn.put(K_KEY_SETTINGS, keys.keySettings);
      if (keys.keySettingsSyncedAt !== undefined)
        await txn.put(K_KEY_SETTINGS_AT, keys.keySettingsSyncedAt);
      if (keys.organizationArchived !== undefined)
        await txn.put(K_ORG_ARCHIVED, keys.organizationArchived);
      if (keys.settledCounter !== undefined) {
        const current =
          (await txn.get<number>(keys.settledCounter.storageKey)) ?? 0;
        const next = current + keys.settledCounter.amount;
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(next)) {
          throw new Error("Settled usage counter exceeds safe integer range");
        }
        await txn.put(keys.settledCounter.storageKey, next);
      }
      for (const deadLetter of keys.settlementDeadLetters ?? []) {
        await txn.put(
          `${K_DEAD_LETTER_PREFIX}${deadLetter.settlement.settlementId}`,
          deadLetter,
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

  /**
   * Outstanding reservations need a maintenance pass even when no settlement
   * is pending, otherwise a crashed executor pins credits until next traffic.
   */
  async #scheduleMaintenanceAlarm(): Promise<void> {
    if (Object.keys(this.#inFlight).length === 0) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing !== undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_ALARM_MS);
  }

  /**
   * Hourly-bounded compaction: free-tier counters older than yesterday and
   * settled-month counters older than the previous UTC month are deleted so
   * DO storage does not grow with lifetime traffic. Cap enforcement only
   * reads the current month; free-tier reads only the current day.
   */
  async #compactCounters(now: number): Promise<boolean> {
    if (now - this.#lastCompactionAt < COMPACTION_INTERVAL_MS) return false;
    this.#lastCompactionAt = now;

    const day = new Date(now);
    const yesterday = utcDayKey(now - 24 * 60 * 60_000);
    const priorMonth = utcMonthKey(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1),
    );
    const keysToDelete: string[] = [];

    const freeEntries = await this.ctx.storage.list({
      prefix: K_FREE_PREFIX,
    });
    for (const key of freeEntries.keys()) {
      const daySuffix = key.slice(key.lastIndexOf(":") + 1);
      if (daySuffix < yesterday) keysToDelete.push(key);
    }

    const settledEntries = await this.ctx.storage.list({
      prefix: K_SETTLED_PREFIX,
    });
    for (const key of settledEntries.keys()) {
      const month = key.slice(key.lastIndexOf(":") + 1);
      if (month < priorMonth) keysToDelete.push(key);
    }

    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete);
    }
    await this.#persist({ lastCompactionAt: this.#lastCompactionAt });
    return true;
  }

  // -------------------------------------------------------------------------
  // RPC operations
  // -------------------------------------------------------------------------

  async grant(grantId: string, amount: number): Promise<GrantResult> {
    if (!grantId || typeof grantId !== "string") {
      return { status: "rejected", reason: "grantId required" };
    }
    if (!(amount > 0) || !Number.isSafeInteger(amount)) {
      return { status: "rejected", reason: "amount must be > 0" };
    }

    return this.#mutate(async () => {
      if (this.#appliedGrantIds.has(grantId)) {
        return { status: "duplicate", balance: this.#balance };
      }

      if (this.#appliedGrantIds.size >= MAX_APPLIED_GRANTS) {
        // Set iterates in insertion order; evict oldest first.
        const oldest = this.#appliedGrantIds.values().next().value;
        if (oldest !== undefined) this.#appliedGrantIds.delete(oldest);
      }
      this.#appliedGrantIds.add(grantId);
      const nextBalance = this.#balance + amount;
      if (!Number.isSafeInteger(nextBalance)) {
        throw new Error("Wallet balance exceeds safe integer range");
      }
      this.#balance = nextBalance;

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
    if (!(cost > 0) || !Number.isSafeInteger(cost)) {
      return { status: "rejected", reason: "cost must be > 0" };
    }

    const now = opts.nowMs ?? Date.now();
    const setting = opts.keyId
      ? await this.#resolveKeySetting(opts.keyId, opts.clerkOrgId, now)
      : null;

    return this.#mutate(async () => {
      if (this.#expireStaleReservations(now)) {
        this.#pruneTerminal(now);
        await this.#persist({
          inFlight: { ...this.#inFlight },
          terminal: { ...this.#terminal },
        });
      }
      if (this.#orgArchived) {
        return { status: "rejected", reason: "organization_archived" };
      }
      const existing = this.#inFlight[reservationId];
      if (existing) {
        if (existing.cost === cost) {
          if (existing.keyBudget === undefined) {
            return {
              status: "conflict",
              reason: "legacy reservation lacks immutable budget identity",
            };
          }
          return {
            status: "duplicate",
            available: this.#available(),
            keyBudget: existing.keyBudget,
          };
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
          reason: `reservation ${reservationId} already ${terminal.status}`,
        };
      }

      // Per-key enforcement: disabled, expired grace, and all active holds.
      const currentSetting = opts.keyId
        ? (this.#keySettings.get(opts.keyId) ?? setting)
        : null;
      const keyId = opts.keyId ?? "unscoped";
      const period = utcMonthKey(now);
      const used =
        (await this.ctx.storage.get<number>(
          settledStorageKey(keyId, period),
        )) ?? 0;
      const reserved = sumInFlightForKey(this.#inFlight, keyId);
      if (opts.keyId && currentSetting) {
        if (this.#isKeyDisabled(currentSetting, now)) {
          return { status: "rejected", reason: "key_disabled" };
        }
        if (currentSetting.monthlyCapCredits !== undefined) {
          const month = utcMonthKey(now);
          const used =
            (await this.ctx.storage.get<number>(
              settledStorageKey(opts.keyId, month),
            )) ?? 0;
          const reserved = sumInFlightForKey(this.#inFlight, opts.keyId);
          const projected = used + reserved + cost;
          if (!Number.isSafeInteger(projected)) {
            return { status: "rejected", reason: "wallet arithmetic overflow" };
          }
          if (projected > currentSetting.monthlyCapCredits) {
            return { status: "rejected", reason: "key_cap_exceeded" };
          }
        }
      }

      const available = this.#available();
      if (available < cost) {
        return { status: "insufficient", available, cost };
      }

      const reservedAt = now;
      const keyBudget: KeyBudgetSnapshot = {
        keyId,
        keyFamilyId: currentSetting?.keyFamilyId ?? keyId,
        ...(currentSetting?.monthlyCapCredits === undefined
          ? {}
          : { monthlyCapCredits: currentSetting.monthlyCapCredits }),
        period,
        usedBefore: used,
        reservedBefore: reserved,
        reservationCredits: cost,
      };
      this.#inFlight[reservationId] = {
        cost,
        createdAt: reservedAt,
        ...(opts.keyId ? { keyId: opts.keyId } : {}),
        keyBudget,
      };
      await this.#persist({ inFlight: { ...this.#inFlight } });
      await this.#scheduleMaintenanceAlarm();

      return { status: "reserved", available: this.#available(), keyBudget };
    });
  }

  async settle(
    reservationId: string,
    usage?: SettlementUsage,
  ): Promise<SettleResult> {
    if (!reservationId) return { status: "unknown" };

    return this.#mutate(async () => {
      const terminal = this.#terminal[reservationId];
      if (terminal?.status === "settled") {
        return {
          status: "already_settled",
          settlementId: settlementIdFor(reservationId),
        };
      }
      if (terminal?.status === "refunded") {
        return { status: "already_refunded" };
      }
      if (terminal?.status === "free") {
        return { status: "already_free" };
      }

      const entry = this.#inFlight[reservationId];
      if (!entry) {
        return { status: "unknown" };
      }

      const settlementId = settlementIdFor(reservationId);
      const settledAt = Date.now();
      const { cost } = entry;
      let authoritativeUsage = usage;
      if (usage !== undefined) {
        if (entry.keyBudget === undefined) {
          return { status: "unknown" };
        }
        const budget = entry.keyBudget;
        authoritativeUsage = {
          ...usage,
          keyId: budget.keyId,
          keyFamilyId: budget.keyFamilyId,
          monthlyCapCredits: budget.monthlyCapCredits,
          budgetPeriod: budget.period,
          budgetUsedBefore: budget.usedBefore,
          budgetReservedBefore: budget.reservedBefore,
          budgetReservationCredits: budget.reservationCredits,
        };
      }

      delete this.#inFlight[reservationId];
      const nextBalance = this.#balance - cost;
      if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) {
        throw new Error("Wallet balance overflow");
      }
      this.#balance = nextBalance;
      this.#terminal[reservationId] = { status: "settled", at: settledAt };
      const pending: PendingSettlement = {
        settlementId,
        reservationId,
        cost,
        settledAt,
      };
      if (authoritativeUsage) pending.usage = authoritativeUsage;
      this.#pendingSettlements.push(pending);

      this.#pruneTerminal(settledAt);
      await this.#persist({
        balance: this.#balance,
        inFlight: { ...this.#inFlight },
        pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
        terminal: { ...this.#terminal },
        ...(authoritativeUsage?.keyId && cost > 0
          ? {
              settledCounter: {
                storageKey: settledStorageKey(
                  authoritativeUsage.keyId,
                  authoritativeUsage.budgetPeriod,
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

  async refund(
    reservationId: string,
    usage?: SettlementUsage,
  ): Promise<RefundResult> {
    if (!reservationId) return { status: "unknown" };

    return this.#mutate(async () => {
      const terminal = this.#terminal[reservationId];
      if (terminal?.status === "refunded") {
        return { status: "already_refunded" };
      }
      if (terminal?.status === "settled") {
        return {
          status: "already_settled",
          settlementId: settlementIdFor(reservationId),
        };
      }
      if (terminal?.status === "free") {
        return { status: "already_free" };
      }

      const entry = this.#inFlight[reservationId];
      if (!entry) {
        return { status: "unknown" };
      }

      const refundedAt = Date.now();
      delete this.#inFlight[reservationId];
      this.#terminal[reservationId] = { status: "refunded", at: refundedAt };
      this.#pruneTerminal(refundedAt);
      if (usage) {
        this.#pendingSettlements.push({
          settlementId: settlementIdFor(reservationId),
          reservationId,
          cost: 0,
          settledAt: Date.now(),
          usage,
        });
      }

      await this.#persist({
        inFlight: { ...this.#inFlight },
        terminal: { ...this.#terminal },
        pendingSettlements: this.#pendingSettlements.map((entry) => ({
          ...entry,
        })),
      });
      if (usage) await this.#scheduleFlushAlarm();

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
    if (!(limit > 0) || !Number.isSafeInteger(limit)) {
      return { status: "rejected", reason: "limit must be > 0" };
    }

    const nowMs = opts.nowMs ?? Date.now();
    const setting = await this.#resolveKeySetting(
      opts.keyId,
      opts.clerkOrgId,
      nowMs,
    );

    return this.#mutate(async () => {
      if (this.#orgArchived) {
        return { status: "rejected", reason: "organization_archived" };
      }
      const currentSetting = this.#keySettings.get(opts.keyId) ?? setting;
      if (currentSetting && this.#isKeyDisabled(currentSetting, nowMs)) {
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
      if (!Number.isSafeInteger(next)) {
        return { status: "rejected", reason: "free-tier counter overflow" };
      }
      await this.ctx.storage.put(storageKey, next);
      const keyBudget = await this.#keyBudgetSnapshot(
        opts.keyId,
        currentSetting,
        nowMs,
        0,
      );
      return {
        status: "consumed",
        used: next,
        usedBefore: used,
        limit,
        keyBudget,
      };
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
      if (this.#orgArchived) {
        return { status: "rejected", reason: "organization_archived" };
      }
      const currentSetting = this.#keySettings.get(keyId) ?? setting;
      if (currentSetting && this.#isKeyDisabled(currentSetting, nowMs)) {
        return { status: "rejected", reason: "key_disabled" };
      }
      if (this.#balance <= 0) {
        return {
          status: "rejected",
          reason: "insufficient_credits",
          available: this.#available(),
        };
      }
      return {
        status: "allowed",
        keyBudget: await this.#keyBudgetSnapshot(
          keyId,
          currentSetting,
          nowMs,
          0,
        ),
      };
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
      if (terminal?.status === "free" || terminal?.status === "settled") {
        return { status: "duplicate", settlementId };
      }
      if (terminal?.status === "refunded") {
        return { status: "rejected", reason: "already refunded" };
      }
      if (this.#inFlight[reservationId]) {
        return { status: "rejected", reason: "reservation in flight" };
      }

      const settledAt = Date.now();
      this.#terminal[reservationId] = { status: "free", at: settledAt };
      this.#pruneTerminal(settledAt);
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
   * Persist ledger acknowledgements. Applied outcomes leave the retry queue.
   * Retryable rejections rotate behind later work. Permanent rejections are
   * validation verdicts — retrying them forever would alarm pointlessly, so
   * they move to a bounded dead-letter queue plus a durable per-settlement
   * proof record for reconciliation. Transient Convex failures never reach
   * this path: recordUsage throws and the whole batch stays pending.
   */
  async applySettlementResults(
    results: SettlementOutcome[],
    checkpoint: WalletCheckpoint,
  ): Promise<AckFlushResult> {
    return this.#mutate(async () => {
      const outcomes = new Map(results.map((result) => [result.refId, result]));
      const retryableRefs = new Set(
        results.flatMap((result) =>
          result.status === "rejected" && result.retryable
            ? [result.refId]
            : [],
        ),
      );
      const removable = new Set(
        results.flatMap((result) =>
          result.status === "rejected" && result.retryable
            ? []
            : [result.refId],
        ),
      );
      const deadLetters = this.#pendingSettlements.flatMap((settlement) => {
        const outcome = outcomes.get(settlement.settlementId);
        return outcome?.status === "rejected" && !outcome.retryable
          ? [
              {
                settlement: { ...settlement },
                reason: outcome.reason,
                rejectedAt: Date.now(),
                terminal: true as const,
                source: "outcome" as const,
              },
            ]
          : [];
      });
      // A sync or concurrent flush may already have installed this checkpoint
      // while these rows were still subtracted as pending. If it is stale now,
      // removing terminal rows must undo that extra local deduction.
      const staleCheckpointAdjustment = this.#pendingSettlements.reduce(
        (total, settlement) => {
          const outcome = outcomes.get(settlement.settlementId);
          return outcome?.status === "applied" ||
            outcome?.status === "already_applied" ||
            (outcome?.status === "rejected" && !outcome.retryable)
            ? total + settlement.cost
            : total;
        },
        0,
      );
      const rejected = new Map(
        results
          .filter((result) => result.status === "rejected")
          .map((result) => [result.refId, result.reason ?? "rejected"]),
      );
      const now = Date.now();
      const before = this.#pendingSettlements.length;
      const deadLettered: DeadLetterSettlement[] = [];
      const retryableRows: PendingSettlement[] = [];
      const retainedRows: PendingSettlement[] = [];
      for (const settlement of this.#pendingSettlements) {
        if (removable.has(settlement.settlementId)) {
          const reason = rejected.get(settlement.settlementId);
          if (reason !== undefined) {
            deadLettered.push({ ...settlement, reason, deadAt: now });
          }
          continue;
        }
        if (retryableRefs.has(settlement.settlementId)) {
          retryableRows.push(settlement);
        } else {
          retainedRows.push(settlement);
        }
      }
      this.#pendingSettlements = [...retainedRows, ...retryableRows];
      const removed = before - this.#pendingSettlements.length;

      if (deadLettered.length > 0) {
        this.#deadLetters = [...this.#deadLetters, ...deadLettered].slice(
          -MAX_DEAD_LETTERS,
        );
      }

      const checkpointAccepted = this.#acceptCheckpoint(checkpoint);
      if (!checkpointAccepted && staleCheckpointAdjustment > 0) {
        this.#balance += staleCheckpointAdjustment;
      }
      if (
        removed > 0 ||
        deadLettered.length > 0 ||
        retryableRows.length > 0 ||
        checkpointAccepted
      ) {
        await this.#persist({
          balance: this.#balance,
          sequence: this.#sequence,
          pendingSettlements: this.#pendingSettlements.map((settlement) => ({
            ...settlement,
          })),
          deadLetters: [...this.#deadLetters],
          settlementDeadLetters: deadLetters,
        });
      }

      return {
        removed,
        rejected: deadLettered.length,
        retryable: retryableRows.length,
        remaining: this.#pendingSettlements.length,
        deadLettered: deadLettered.length,
      };
    });
  }

  /** Permanently terminate one deterministic batch poison with durable proof. */
  async #deadLetterSingleton(
    settlementId: string,
    reason: string,
  ): Promise<boolean> {
    return this.#mutate(async () => {
      const index = this.#pendingSettlements.findIndex(
        (settlement) => settlement.settlementId === settlementId,
      );
      if (index < 0) return false;
      const settlement = this.#pendingSettlements[index]!;
      this.#pendingSettlements.splice(index, 1);
      // Deterministic batch failure never committed this row upstream. Remove
      // its local pending deduction so working balance matches ledger truth.
      this.#balance += settlement.cost;
      this.#deadLetters = [
        ...this.#deadLetters,
        { ...settlement, reason, deadAt: Date.now() },
      ].slice(-MAX_DEAD_LETTERS);
      await this.#persist({
        balance: this.#balance,
        pendingSettlements: this.#pendingSettlements.map((entry) => ({
          ...entry,
        })),
        deadLetters: [...this.#deadLetters],
        settlementDeadLetters: [
          {
            settlement: { ...settlement },
            reason,
            rejectedAt: Date.now(),
            terminal: true,
            source: "batch",
          },
        ],
      });
      return true;
    });
  }

  /** Dead-letter queue snapshot for reconciliation tooling and tests. */
  async getDeadLetters(): Promise<DeadLetterSettlement[]> {
    return this.#deadLetters.map((settlement) => ({ ...settlement }));
  }

  /**
   * Flush pending settlements that have usage metadata to Convex, then ack.
   * Rows without usage are left for the SimulatedLedger-style test path.
   */
  async flushToConvex(): Promise<FlushToConvexResult> {
    if (this.#pendingSettlements.length === 0) {
      return {
        flushed: 0,
        acked: 0,
        rejected: 0,
        retryable: 0,
        blocked: 0,
        remaining: 0,
      };
    }

    const flushable = await this.#mutate(async () =>
      this.#pendingSettlements
        .filter((settlement) => settlement.usage !== undefined)
        .slice(0, USAGE_FLUSH_BATCH_SIZE)
        .map((settlement) => ({ ...settlement })),
    );
    if (flushable.length === 0) {
      return {
        flushed: 0,
        acked: 0,
        rejected: 0,
        retryable: 0,
        blocked: 0,
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
          reservationId: s.reservationId,
          cost: s.cost,
          settledAt: s.settledAt,
          organizationId: usage.organizationId,
          consumerClerkOrgId: usage.consumerClerkOrgId,
          projectId: usage.projectId,
          specVersionId: usage.specVersionId,
          specVersion: usage.specVersion,
          operationId: usage.operationId,
          endpoint: usage.endpoint,
          method: usage.method,
          listedCostCredits: usage.listedCostCredits,
          freeTierLimit: usage.freeTierLimit,
          freeTierUsedBefore: usage.freeTierUsedBefore,
          pricingDecision: usage.pricingDecision,
          status: usage.status,
          latencyMs: usage.latencyMs,
          keyId: usage.keyId,
          billingOutcome: usage.billingOutcome,
          qualityOutcome: usage.qualityOutcome,
          keyFamilyId: usage.keyFamilyId,
          monthlyCapCredits: usage.monthlyCapCredits,
          budgetPeriod: usage.budgetPeriod,
          budgetUsedBefore: usage.budgetUsedBefore,
          budgetReservedBefore: usage.budgetReservedBefore,
          budgetReservationCredits: usage.budgetReservationCredits,
          ambiguous: usage.ambiguous,
          publisherIdempotencyKey: usage.publisherIdempotencyKey,
        }),
      );
    }

    const client = this.#buildUsageClient();
    if (!client) {
      return {
        flushed: 0,
        acked: 0,
        rejected: 0,
        retryable: 0,
        blocked: 0,
        remaining: this.#pendingSettlements.length,
        error: "convex client not configured",
      };
    }

    const submissions = await submitWithPoisonBisection(
      events,
      async (batch) => await client.recordUsage([...batch]),
      usageFailureDisposition,
    );

    let acked = 0;
    let rejected = 0;
    let retryable = submissions.retryable.length;
    const blocked = submissions.blocked.length;
    for (const submission of submissions.successes) {
      const ack = await this.applySettlementResults(
        submission.result.results,
        submission.result.wallet,
      );
      acked += ack.removed - ack.rejected;
      rejected += ack.rejected;
      retryable += ack.retryable;
    }
    for (const terminal of submissions.terminals) {
      if (
        await this.#deadLetterSingleton(
          terminal.item.settleRefId,
          terminal.error,
        )
      ) {
        rejected += 1;
      }
    }

    return {
      flushed:
        events.length -
        submissions.retryable.length -
        submissions.blocked.length,
      acked,
      rejected,
      retryable,
      blocked,
      remaining: this.#pendingSettlements.length,
      ...(retryable > 0 || blocked > 0
        ? {
            error:
              submissions.retryableErrors[0] ??
              submissions.blockedErrors[0] ??
              `${retryable + blocked} settlement(s) unresolved`,
          }
        : {}),
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

  async getSettlementQueueLayout(): Promise<SettlementQueueLayout> {
    return await inspectSettlementQueue(this.ctx.storage);
  }

  async getSettlementDeadLetter(
    settlementId: string,
  ): Promise<SettlementDeadLetter | null> {
    if (!settlementId || typeof settlementId !== "string") return null;
    return (
      (await this.ctx.storage.get<SettlementDeadLetter>(
        `${K_DEAD_LETTER_PREFIX}${settlementId}`,
      )) ?? null
    );
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
      // Archive is terminal. Never reopen from an older/non-terminal response.
      this.#orgArchived ||= synced.archived;
      this.#acceptCheckpoint(synced.wallet);

      await this.#persist({
        balance: this.#balance,
        sequence: this.#sequence,
        keySettings: Object.fromEntries(this.#keySettings),
        keySettingsSyncedAt: this.#keySettingsSyncedAt,
        organizationArchived: this.#orgArchived,
      });

      return {
        status: "ok",
        balance: this.#balance,
        sequence: this.#sequence,
      };
    });
  }

  /**
   * Resolve key settings off the request hot path. Stale-but-present cache
   * entries serve immediately while a single-flight refresh runs in the
   * background (stale-while-revalidate, bounded by SYNC_GRANTS_WINDOW_MS).
   * Only first contact (never synced) blocks, so a cold DO cannot enforce
   * caps against settings it has never seen.
   */
  async #resolveKeySetting(
    keyId: string,
    clerkOrgId: string | undefined,
    nowMs: number,
  ): Promise<KeySetting | null> {
    if (!clerkOrgId) return null;
    const stale = nowMs - this.#keySettingsSyncedAt >= SYNC_GRANTS_WINDOW_MS;
    if (stale) {
      if (this.#keySettingsSyncedAt === 0) {
        await this.#syncGrantsSingleFlight(clerkOrgId, nowMs);
      } else {
        this.ctx.waitUntil(
          this.#syncGrantsSingleFlight(clerkOrgId, nowMs).then(
            () => undefined,
            () => undefined,
          ),
        );
      }
    }
    return this.#keySettings.get(keyId) ?? null;
  }

  async #keyBudgetSnapshot(
    keyId: string,
    setting: KeySetting | null,
    nowMs: number,
    reservationCredits: number,
  ): Promise<KeyBudgetSnapshot> {
    const period = utcMonthKey(nowMs);
    const usedBefore =
      (await this.ctx.storage.get<number>(settledStorageKey(keyId, period))) ??
      0;
    return {
      keyId,
      keyFamilyId: setting?.keyFamilyId ?? keyId,
      ...(setting?.monthlyCapCredits === undefined
        ? {}
        : { monthlyCapCredits: setting.monthlyCapCredits }),
      period,
      usedBefore,
      reservedBefore: sumInFlightForKey(this.#inFlight, keyId),
      reservationCredits,
    };
  }

  #isKeyDisabled(setting: KeySetting, nowMs: number): boolean {
    return (
      setting.disabled ||
      setting.rotationRequiredAt !== undefined ||
      (setting.graceUntil !== undefined && nowMs >= setting.graceUntil)
    );
  }

  /**
   * Accept a newer ledger projection, or a direct settlement response at the
   * current sequence. Pending local settlements are deducted until their
   * per-reference outcome is acknowledged; holds stay in #inFlight.
   */
  #acceptCheckpoint(checkpoint: WalletCheckpoint): boolean {
    if (
      !Number.isSafeInteger(checkpoint.sequence) ||
      checkpoint.sequence < 0 ||
      !Number.isSafeInteger(checkpoint.balance)
    ) {
      throw new Error("Invalid wallet checkpoint");
    }
    if (checkpoint.sequence <= this.#sequence) return false;
    this.#sequence = checkpoint.sequence;
    const balance =
      checkpoint.balance - sumPendingCosts(this.#pendingSettlements);
    if (!Number.isSafeInteger(balance)) {
      throw new Error("Wallet checkpoint underflow");
    }
    this.#balance = balance;
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
    archived: boolean;
  } | null> {
    const testFn = getTestGrantsFetcher();
    if (testFn) {
      const r = await testFn(clerkOrgId);
      if (r === null) return null;
      return {
        ...r,
        keySettings: r.keySettings ?? [],
        archived: r.archived ?? false,
      };
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
        archived?: unknown;
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
        archived: json.archived === true,
      };
    } catch {
      return null;
    }
  }

  /**
   * Alarm: expire stale reservations and compact counters on the maintenance
   * cadence, then batch-flush pending usage to Convex when configured.
   * Re-arms fast while pending remains, slow while reservations are open.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    await this.#mutate(async () => {
      const expired = this.#expireStaleReservations(now);
      this.#pruneTerminal(now);
      const compacted = await this.#compactCounters(now);
      if (expired || compacted) {
        await this.#persist({
          inFlight: { ...this.#inFlight },
          terminal: { ...this.#terminal },
        });
      }
    });

    if (this.#pendingSettlements.length > 0) {
      const hasUsage = this.#pendingSettlements.some(
        (s) => s.usage !== undefined,
      );
      if (hasUsage) {
        await this.flushToConvex();
      }
    }

    if (this.#pendingSettlements.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
    } else if (Object.keys(this.#inFlight).length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_ALARM_MS);
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
  archived?: boolean;
} | null>;

let testGrantsFetcher: TestGrantsFetcher | null = null;

/** Test harness: override the Convex /wallet-grants fetch (no network). */
export function __setTestGrantsFetcher(fn: TestGrantsFetcher | null): void {
  testGrantsFetcher = fn;
}

function getTestGrantsFetcher(): TestGrantsFetcher | null {
  return testGrantsFetcher;
}
