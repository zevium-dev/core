/**
 * Async usage event emission after a metered call.
 * Console sink for now; Convex sink lands with control-plane wave.
 */

export type UsageEvent = {
  requestId: string;
  organizationId: string;
  projectId: string;
  keyId: string;
  orgSlug: string;
  projectSlug: string;
  method: string;
  pathTemplate: string;
  cost: number;
  status: number;
  /** settled | refunded | blocked */
  outcome: "settled" | "refunded" | "blocked";
  latencyMs: number;
  reservationId: string;
};

export interface UsageSink {
  emit(event: UsageEvent): Promise<void> | void;
}

export class ConsoleUsageSink implements UsageSink {
  emit(event: UsageEvent): void {
    console.log(
      JSON.stringify({
        type: "zevium.usage",
        ...event,
      }),
    );
  }
}

/** Collecting sink for tests. */
export class CollectingUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];

  emit(event: UsageEvent): void {
    this.events.push(event);
  }
}
