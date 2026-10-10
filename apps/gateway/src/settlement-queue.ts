import { MAX_USAGE_INGEST_EVENTS } from "@zevium/shared";

export const SETTLEMENT_QUEUE_PARTITION_SIZE = MAX_USAGE_INGEST_EVENTS;

export type SettlementQueueLayout = {
  size: number;
  partitionCount: number;
  partitionSizes: number[];
};

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
