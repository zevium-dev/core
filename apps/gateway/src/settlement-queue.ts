import { MAX_USAGE_INGEST_EVENTS } from "@zevium/shared";

export const SETTLEMENT_QUEUE_PARTITION_SIZE = MAX_USAGE_INGEST_EVENTS;

const QUEUE_META_KEY = "pendingSettlements:v2:meta";
const QUEUE_PARTITION_PREFIX = "pendingSettlements:v2:partition:";

type QueueMeta = {
  version: 2;
  size: number;
  partitionCount: number;
};

export type SettlementQueueLayout = {
  size: number;
  partitionCount: number;
  partitionSizes: number[];
};

function partitionKey(index: number): string {
  return `${QUEUE_PARTITION_PREFIX}${index}`;
}

function validMeta(value: unknown): value is QueueMeta {
  if (value === null || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    meta.version === 2 &&
    Number.isSafeInteger(meta.size) &&
    (meta.size as number) >= 0 &&
    Number.isSafeInteger(meta.partitionCount) &&
    (meta.partitionCount as number) >= 0 &&
    (meta.partitionCount as number) ===
      Math.ceil((meta.size as number) / SETTLEMENT_QUEUE_PARTITION_SIZE)
  );
}

/** Load every bounded queue partition and reject torn/corrupt layouts. */
export async function readSettlementQueue<T>(
  storage: DurableObjectStorage,
): Promise<T[] | null> {
  const rawMeta = await storage.get<unknown>(QUEUE_META_KEY);
  if (rawMeta === undefined) return null;
  if (!validMeta(rawMeta)) throw new Error("invalid settlement queue metadata");

  const rows: T[] = [];
  for (let index = 0; index < rawMeta.partitionCount; index += 1) {
    const partition = await storage.get<unknown>(partitionKey(index));
    if (
      !Array.isArray(partition) ||
      partition.length === 0 ||
      partition.length > SETTLEMENT_QUEUE_PARTITION_SIZE ||
      (index < rawMeta.partitionCount - 1 &&
        partition.length !== SETTLEMENT_QUEUE_PARTITION_SIZE)
    ) {
      throw new Error("invalid settlement queue partition");
    }
    rows.push(...(partition as T[]));
  }
  if (rows.length !== rawMeta.size) {
    throw new Error("settlement queue size mismatch");
  }
  return rows;
}

/**
 * Atomically replace queue using bounded values. Wallet state and queue can be
 * committed in one Durable Object transaction; no giant storage blob exists.
 */
export async function writeSettlementQueue<T>(
  txn: DurableObjectTransaction,
  rows: readonly T[],
): Promise<void> {
  const rawPrevious = await txn.get<unknown>(QUEUE_META_KEY);
  if (rawPrevious !== undefined && !validMeta(rawPrevious)) {
    throw new Error("invalid settlement queue metadata");
  }
  const previousCount = validMeta(rawPrevious) ? rawPrevious.partitionCount : 0;
  const partitionCount = Math.ceil(
    rows.length / SETTLEMENT_QUEUE_PARTITION_SIZE,
  );

  for (let index = 0; index < partitionCount; index += 1) {
    const start = index * SETTLEMENT_QUEUE_PARTITION_SIZE;
    await txn.put(
      partitionKey(index),
      rows.slice(start, start + SETTLEMENT_QUEUE_PARTITION_SIZE),
    );
  }
  for (let index = partitionCount; index < previousCount; index += 1) {
    await txn.delete(partitionKey(index));
  }

  if (rows.length === 0) {
    await txn.delete(QUEUE_META_KEY);
    return;
  }
  await txn.put(QUEUE_META_KEY, {
    version: 2,
    size: rows.length,
    partitionCount,
  } satisfies QueueMeta);
}

/** Public diagnostics used by restart/crash boundary tests and operations. */
export async function inspectSettlementQueue(
  storage: DurableObjectStorage,
): Promise<SettlementQueueLayout> {
  const rawMeta = await storage.get<unknown>(QUEUE_META_KEY);
  if (rawMeta === undefined) {
    return { size: 0, partitionCount: 0, partitionSizes: [] };
  }
  if (!validMeta(rawMeta)) throw new Error("invalid settlement queue metadata");
  const partitionSizes: number[] = [];
  let observedSize = 0;
  for (let index = 0; index < rawMeta.partitionCount; index += 1) {
    const partition = await storage.get<unknown>(partitionKey(index));
    if (
      !Array.isArray(partition) ||
      partition.length === 0 ||
      partition.length > SETTLEMENT_QUEUE_PARTITION_SIZE ||
      (index < rawMeta.partitionCount - 1 &&
        partition.length !== SETTLEMENT_QUEUE_PARTITION_SIZE)
    ) {
      throw new Error("invalid settlement queue partition");
    }
    partitionSizes.push(partition.length);
    observedSize += partition.length;
  }
  if (observedSize !== rawMeta.size) {
    throw new Error("settlement queue size mismatch");
  }
  return {
    size: rawMeta.size,
    partitionCount: rawMeta.partitionCount,
    partitionSizes,
  };
}

export type BisectionSuccess<T, R> = { items: T[]; result: R };
export type BisectionTerminal<T> = { item: T; error: string };

export type BisectionResult<T, R> = {
  successes: Array<BisectionSuccess<T, R>>;
  retryable: T[];
  retryableErrors: string[];
  blocked: T[];
  blockedErrors: string[];
  terminals: Array<BisectionTerminal<T>>;
};

export type SubmissionFailureDisposition =
  "retryable" | "bisectable" | "blocked";

/**
 * Split row-scoped deterministic failures until one poison row remains.
 * Retryable and systemic blocked failures stay queued; only a bisectable
 * singleton terminates.
 */
export async function submitWithPoisonBisection<T, R>(
  items: readonly T[],
  submit: (batch: readonly T[]) => Promise<R>,
  classify: (error: unknown) => SubmissionFailureDisposition,
): Promise<BisectionResult<T, R>> {
  const output: BisectionResult<T, R> = {
    successes: [],
    retryable: [],
    retryableErrors: [],
    blocked: [],
    blockedErrors: [],
    terminals: [],
  };

  const visit = async (batch: readonly T[]): Promise<void> => {
    try {
      output.successes.push({ items: [...batch], result: await submit(batch) });
    } catch (error) {
      const disposition = classify(error);
      const message = error instanceof Error ? error.message : String(error);
      if (disposition === "retryable") {
        output.retryable.push(...batch);
        output.retryableErrors.push(message);
        return;
      }
      if (disposition === "blocked") {
        output.blocked.push(...batch);
        output.blockedErrors.push(message);
        return;
      }
      if (batch.length === 1) {
        output.terminals.push({
          item: batch[0]!,
          error: message,
        });
        return;
      }
      const midpoint = Math.floor(batch.length / 2);
      await visit(batch.slice(0, midpoint));
      await visit(batch.slice(midpoint));
    }
  };

  if (items.length > 0) await visit(items);
  return output;
}
