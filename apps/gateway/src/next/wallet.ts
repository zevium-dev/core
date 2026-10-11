import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  admission,
  admittedRequest,
  settlement,
  settlementOutcome,
  type Admission,
  type Settlement,
} from "@zevium/shared/edge/settlement";
import {
  admissionFingerprint,
  fingerprint,
  sign,
} from "@zevium/shared/edge/transport";
import {
  walletPage,
  readRing,
  type Checkpoint,
  type KeyPolicy,
  type WalletPage,
} from "@zevium/shared/edge/replication";
import { keyPolicy } from "@zevium/shared/edge/snapshots";
import {
  coldRefreshBudget,
  COLD_FILL_MS,
  waitForColdFill,
} from "./cold-refresh";
import { pull, type NextEnv } from "./snapshots";

type RecordRow = {
  seq: number;
  data: string;
  final: string | null;
  ack: string | null;
  deadline: number;
};
type State = {
  checkpoint: Checkpoint;
  nextSequence: number;
  freeze?: WalletPage["freeze"];
  ack?: unknown;
  sealed: boolean;
  lastAdmit?: number;
};
const admissionInput = admission.omit({
  walletId: true,
  ownerKey: true,
  epoch: true,
  edgeSequence: true,
  heldCredits: true,
  fundingSlices: true,
  pricingDecision: true,
  keyFamilyId: true,
  ownerUserId: true,
  budgetPeriod: true,
  budgetUsedBefore: true,
  budgetReservedBefore: true,
  monthlyCapCredits: true,
  freeTierUsedBefore: true,
  admissionKeyId: true,
});
// admittedRequest is refined; the explicit public input is validated again as a complete Admission before persistence.
export type AdmissionInput = z.infer<typeof admissionInput>;
export type AdmissionResult =
  | { ok: true; admission: Admission }
  | {
      ok: false;
      reason: string;
      status: number;
      retryAfter?: number;
      cost?: number;
      available?: number;
    };
export class NextWalletDO extends DurableObject<NextEnv> {
  private checkpointPending?: Promise<void>;
  private coldRetryAt = 0;
  constructor(ctx: DurableObjectState, env: NextEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS next_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS next_calls (seq INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, data TEXT NOT NULL, final TEXT, ack TEXT, deadline INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS next_sources (id TEXT PRIMARY KEY, lot TEXT NOT NULL, data TEXT NOT NULL, available INTEGER NOT NULL, priority INTEGER NOT NULL, created INTEGER NOT NULL, source_created INTEGER NOT NULL, origin TEXT NOT NULL, expires INTEGER)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS next_source_order ON next_sources(priority,created,lot,source_created,origin)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS next_counters (id TEXT PRIMARY KEY, value REAL NOT NULL, at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS next_failures (ref TEXT PRIMARY KEY, evidence TEXT NOT NULL, reason TEXT NOT NULL)",
    );
  }
  private state(): State | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM next_state WHERE id=1")
      .toArray()[0];
    return row ? (JSON.parse(row.data) as State) : null;
  }
  private save(s: State) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO next_state VALUES(1,?)",
      JSON.stringify(s),
    );
  }
  private counter(id: string) {
    return (
      this.ctx.storage.sql
        .exec<{ value: number; at: number }>(
          "SELECT value,at FROM next_counters WHERE id=?",
          id,
        )
        .toArray()[0] ?? { value: 0, at: Date.now() }
    );
  }
  private setCounter(id: string, value: number, at = Date.now()) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO next_counters VALUES(?,?,?)",
      id,
      value,
      at,
    );
  }
  private calls() {
    return this.ctx.storage.sql
      .exec<RecordRow>(
        "SELECT seq,data,final,ack,deadline FROM next_calls ORDER BY seq",
      )
      .toArray();
  }
  /** Exact private evidence for internal operator recovery; never an ACK. */
  async failureEvidence(settleRefId: string) {
    z.string().min(1).max(512).parse(settleRefId);
    const row = this.ctx.storage.sql
      .exec<{ evidence: string; reason: string }>(
        "SELECT f.evidence,f.reason FROM next_failures f JOIN next_calls c ON json_extract(c.data, '$.settleRefId')=f.ref WHERE f.ref=? AND c.ack IS NULL",
        settleRefId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      eventJson: row.evidence,
      expectedFingerprint: await fingerprint(JSON.parse(row.evidence)),
      expectedWatermark: this.state()?.checkpoint.settledThroughEdgeSequence,
      reason: row.reason,
    };
  }
  async wake(clerkOrgId: string, maintenance = true) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const old = await this.ctx.storage.get<string>("owner");
      if (old && old !== clerkOrgId)
        throw new Error("Wallet identity mismatch");
      if (!old)
        await this.ctx.storage.put({
          owner: clerkOrgId,
          bootstrapId: crypto.randomUUID(),
          lastWake: Date.now(),
        });
      if (maintenance) await this.ctx.storage.put("lastWake", Date.now());
      if (maintenance && (await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 1);
    });
  }
  async admit(
    input: AdmissionInput,
    key: KeyPolicy,
    validUntil: number,
  ): Promise<AdmissionResult> {
    input = admissionInput.parse(input);
    key = keyPolicy.parse(key);
    if (!Number.isSafeInteger(validUntil))
      throw new Error("Invalid authority deadline");
    await this.wake(input.consumerClerkOrgId, false);
    const current = this.state();
    if (!current || current.checkpoint.validUntil <= Date.now()) {
      if (this.checkpointPending)
        await waitForColdFill(this.checkpointPending).catch(() => {});
      else if (Date.now() >= this.coldRetryAt && coldRefreshBudget.take()) {
        this.coldRetryAt = Date.now() + 5000;
        await waitForColdFill(
          this.refreshCheckpoint(
            input.consumerClerkOrgId,
            AbortSignal.timeout(COLD_FILL_MS),
          ),
        ).catch(() => {});
      }
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = this.state(),
        now = Date.now();
      const reject = (
        reason: string,
        status = 503,
        retryAfter?: number,
      ): AdmissionResult => ({
        ok: false,
        reason,
        status,
        ...(retryAfter ? { retryAfter } : {}),
        cost: input.listedCostCredits,
      });
      if (
        !s ||
        s.checkpoint.validUntil <= now ||
        validUntil <= now ||
        s.checkpoint.gateState !== "open" ||
        s.sealed ||
        s.freeze
      )
        return reject("wallet_unavailable");
      if (
        input.consumerClerkOrgId !== s.checkpoint.owner.clerkOrgId ||
        input.deploymentId !== s.checkpoint.deploymentId ||
        input.keyId !== key.keyId
      )
        return reject("key_untracked", 403);
      if (
        key.lifecycle === "disabled" ||
        (key.expiresAt !== undefined && key.expiresAt <= now) ||
        (key.graceUntil !== undefined && key.graceUntil <= now)
      )
        return reject("key_disabled", 403);
      const rateId = `rate:${key.keyId}`,
        rate = this.ctx.storage.sql
          .exec<{ value: number; at: number }>(
            "SELECT value,at FROM next_counters WHERE id=?",
            rateId,
          )
          .toArray()[0],
        tokens = rate ? Math.min(60, rate.value + (now - rate.at) / 1000) : 60;
      if (tokens < 1)
        return reject(
          "key_rate_limited",
          429,
          Math.max(1, Math.ceil(1 - tokens)),
        );
      this.setCounter(rateId, tokens - 1, now);
      const rows = this.calls();
      if (rows.length >= 1000) return reject("wallet_unavailable");
      const pending = rows.map((r) => ({
        r,
        a: JSON.parse(r.data) as Admission,
        f: r.final ? (JSON.parse(r.final) as Settlement) : null,
      }));
      const debt = pending.reduce(
        (n, { a, f }) => n + (!f ? a.heldCredits : f.credits),
        0,
      );
      if (s.checkpoint.balance - debt <= 0)
        return {
          ...reject("insufficient_credits", 402),
          available: Math.max(0, s.checkpoint.balance - debt),
        };
      const period = new Date(now).toISOString().slice(0, 7),
        budgetId = `budget:${key.keyFamilyId}:${period}`;
      const used = this.counter(budgetId).value;
      const reserved = pending.reduce(
        (n, { a, f }) =>
          n +
          (!f && a.keyFamilyId === key.keyFamilyId && a.budgetPeriod === period
            ? a.heldCredits
            : 0),
        0,
      );
      const freeId = `free:${input.projectId}:${input.method}:${input.endpoint}:${new Date(now).toISOString().slice(0, 10)}`;
      const freeUsed = this.counter(freeId).value;
      const free =
        input.listedCostCredits > 0 &&
        input.freeTierLimit !== undefined &&
        freeUsed < input.freeTierLimit;
      const cost = free ? 0 : input.listedCostCredits;
      if (
        key.monthlyCapCredits !== undefined &&
        used + reserved + cost > key.monthlyCapCredits
      )
        return reject("key_cap_exceeded", 402);
      if (cost > s.checkpoint.balance - debt)
        return {
          ...reject("insufficient_credits", 402),
          available: Math.max(0, s.checkpoint.balance - debt),
        };
      const sources = this.ctx.storage.sql
        .exec<{ id: string; data: string; available: number }>(
          "SELECT id,data,available FROM next_sources WHERE available>0 AND (expires IS NULL OR expires>?) ORDER BY priority,created,lot,source_created,origin LIMIT 33",
          now,
        )
        .toArray()
        .map((r) => ({
          ...(JSON.parse(r.data) as {
            source: Checkpoint["sources"][number];
            lot: Checkpoint["lots"][number];
          }),
          available: r.available,
        }));
      const slices: Admission["fundingSlices"] = [];
      let remaining = cost;
      for (const { source, lot, available } of sources) {
        if (remaining === 0) break;
        if (lot.expiresAt !== undefined && lot.expiresAt <= now) continue;
        if (available <= 0) continue;
        if (slices.length === 32)
          return reject("funding_capacity_exceeded", 503);
        const credits = Math.min(available, remaining);
        slices.push({
          lotId: source.lotId,
          originLotId: source.originLotId,
          sourceRef: source.sourceRef,
          ...(source.paymentId ? { paymentId: source.paymentId } : {}),
          credits,
        });
        remaining -= credits;
      }
      if (remaining > 0)
        return {
          ...reject("insufficient_credits", 402),
          available: Math.max(0, s.checkpoint.balance - debt),
        };
      const ring = readRing(this.env.NEXT_ADMISSION_KEYS);
      const a = admittedRequest.parse({
        ...input,
        admittedAt: now,
        walletId: s.checkpoint.walletId,
        ownerKey: s.checkpoint.ownerKey,
        epoch: s.checkpoint.epoch,
        edgeSequence: s.nextSequence + 1,
        heldCredits: cost,
        fundingSlices: slices,
        pricingDecision: free
          ? "free_tier"
          : cost === 0
            ? "zero_price"
            : "listed_price",
        keyFamilyId: key.keyFamilyId,
        ownerUserId: key.ownerUserId,
        budgetPeriod: period,
        budgetUsedBefore: used,
        budgetReservedBefore: reserved,
        ...(key.monthlyCapCredits !== undefined
          ? { monthlyCapCredits: key.monthlyCapCredits }
          : {}),
        ...(free ? { freeTierUsedBefore: freeUsed } : {}),
        admissionKeyId: ring.current,
      });
      const proof = await admissionFingerprint(a, ring.keys[ring.current]!);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO next_calls VALUES(?,?,?,?,?,?)",
          a.edgeSequence,
          a.reservationId,
          JSON.stringify(a),
          null,
          null,
          now + 60_000,
        );
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO next_failures VALUES(?,?,?)",
          `proof:${a.reservationId}`,
          proof,
          "admission",
        );
        for (const slice of slices)
          this.ctx.storage.sql.exec(
            "UPDATE next_sources SET available=available-? WHERE id=?",
            slice.credits,
            JSON.stringify([slice.lotId, slice.originLotId]),
          );
        if (free) this.setCounter(freeId, freeUsed + 1);
        this.save({ ...s, nextSequence: a.edgeSequence, lastAdmit: now });
      });
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 15_000);
      return { ok: true, admission: a };
    });
  }
  async finalize(
    reservationId: string,
    status: number,
    latencyMs: number,
    recoveryUnknown = false,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const row = this.ctx.storage.sql
        .exec<RecordRow>(
          "SELECT seq,data,final,ack,deadline FROM next_calls WHERE ref=?",
          reservationId,
        )
        .toArray()[0];
      if (!row) throw new Error("Admission unavailable");
      if (row.final) return;
      const a = JSON.parse(row.data) as Admission,
        success = status >= 200 && status < 300;
      const proof = this.ctx.storage.sql
        .exec<{ evidence: string }>(
          "SELECT evidence FROM next_failures WHERE ref=?",
          `proof:${reservationId}`,
        )
        .one().evidence;
      const event = settlement.parse({
        ...a,
        admissionFingerprint: proof,
        credits: success ? a.heldCredits : 0,
        status,
        latencyMs: Math.max(0, Math.round(latencyMs)),
        at: Math.max(Date.now(), a.admittedAt),
        billingOutcome: success
          ? a.heldCredits > 0
            ? "settled"
            : "free"
          : "refunded",
        qualityOutcome: success
          ? "success"
          : status === 502
            ? "network_error"
            : status >= 500
              ? "server_error"
              : status >= 400
                ? "client_error"
                : "network_error",
        ambiguous: recoveryUnknown,
        ...(recoveryUnknown ? { recoveryUnknown: true } : {}),
      });
      const ring = readRing(this.env.NEXT_ADMISSION_KEYS),
        secret = ring.keys[a.admissionKeyId!];
      if (!secret)
        throw new Error("Unacknowledged signing key must be retained");
      event.finalFingerprint = await sign(
        { purpose: "final:v2", facts: event },
        secret,
      );
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE next_calls SET final=? WHERE ref=?",
          JSON.stringify(event),
          reservationId,
        );
        if (!success)
          for (const slice of a.fundingSlices)
            this.ctx.storage.sql.exec(
              "UPDATE next_sources SET available=available+? WHERE id=?",
              slice.credits,
              JSON.stringify([slice.lotId, slice.originLotId]),
            );
        if (success) {
          const id = `budget:${a.keyFamilyId}:${a.budgetPeriod}`;
          this.setCounter(id, this.counter(id).value + event.credits);
        }
        if (!success && a.pricingDecision === "free_tier") {
          const id = `free:${a.projectId}:${a.method}:${a.endpoint}:${new Date(a.admittedAt).toISOString().slice(0, 10)}`;
          this.setCounter(id, Math.max(0, this.counter(id).value - 1));
        }
      });
      await this.ctx.storage.setAlarm(Date.now() + 1);
    });
  }
  private install(pages: WalletPage[], bootstrapId: string) {
    const cp = pages[0]!.checkpoint,
      old = this.state();
    if (
      cp.validUntil <= Date.now() ||
      cp.deploymentId !== this.env.NEXT_DEPLOYMENT_ID ||
      cp.edgeBootstrapId !== bootstrapId
    )
      throw new Error("Expired checkpoint");
    if (
      old &&
      (cp.epoch < old.checkpoint.epoch ||
        cp.sequence < old.checkpoint.sequence ||
        cp.gateRevision < old.checkpoint.gateRevision ||
        (cp.epoch === old.checkpoint.epoch &&
          cp.settledThroughEdgeSequence <
            old.checkpoint.settledThroughEdgeSequence))
    )
      throw new Error("Checkpoint rollback");
    if (
      old &&
      cp.epoch > old.checkpoint.epoch &&
      (!(
        old.sealed ||
        old.checkpoint.gateState === "closed" ||
        old.checkpoint.gateState === "maintenance"
      ) ||
        this.calls().some((r) => !r.ack))
    )
      throw new Error("Unsealed prior epoch");
    if (
      !old &&
      (!["open", "closing"].includes(cp.gateState) ||
        cp.epoch !== 1 ||
        cp.settledThroughEdgeSequence !== 0)
    )
      throw new Error("Lost wallet requires operator recovery");
    if (old?.checkpoint.generationId === cp.generationId) {
      this.save({
        ...old,
        checkpoint: { ...old.checkpoint, validUntil: cp.validUntil },
      });
      return;
    }
    const sources = pages.flatMap((p) => p.checkpoint.sources),
      lots = new Map(
        pages.flatMap((p) => p.checkpoint.lots).map((l) => [l.lotId, l]),
      );
    if (
      new Set(sources.map((s) => JSON.stringify([s.lotId, s.originLotId])))
        .size !== sources.length ||
      sources.reduce((n, s) => n + s.remainingCredits, 0) !== cp.balance
    )
      throw new Error("Incomplete inventory");
    const calls = this.calls();
    for (const r of calls)
      if (r.seq <= cp.settledThroughEdgeSequence && (!r.final || !r.ack))
        throw new Error("Missing final acknowledgement");
    const reserved = new Map<string, number>();
    if (old?.checkpoint.epoch === cp.epoch)
      for (const r of calls) {
        if (r.seq <= cp.settledThroughEdgeSequence) continue;
        const a = JSON.parse(r.data) as Admission,
          f = r.final ? (JSON.parse(r.final) as Settlement) : null;
        if (!f || f.credits > 0)
          for (const slice of a.fundingSlices) {
            const id = JSON.stringify([slice.lotId, slice.originLotId]);
            reserved.set(id, (reserved.get(id) ?? 0) + slice.credits);
          }
      }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM next_sources");
      for (const source of sources) {
        const lot = lots.get(source.lotId);
        if (!lot) throw new Error("Missing container");
        const id = JSON.stringify([source.lotId, source.originLotId]),
          available = source.remainingCredits - (reserved.get(id) ?? 0);
        if (available < 0) throw new Error("Checkpoint conflicts with hold");
        this.ctx.storage.sql.exec(
          "INSERT INTO next_sources VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          source.lotId,
          JSON.stringify({ source, lot }),
          available,
          lot.priority,
          lot.createdAt,
          source.sourceCreatedAt,
          source.originLotId,
          lot.expiresAt ?? null,
        );
      }
      for (const r of calls)
        if (
          r.ack &&
          (cp.epoch > JSON.parse(r.data).epoch ||
            r.seq <= cp.settledThroughEdgeSequence)
        ) {
          const a = JSON.parse(r.data) as Admission;
          this.ctx.storage.sql.exec(
            "DELETE FROM next_failures WHERE ref=?",
            `proof:${a.reservationId}`,
          );
        }
      if (old && cp.epoch > old.checkpoint.epoch)
        this.ctx.storage.sql.exec("DELETE FROM next_calls");
      else
        this.ctx.storage.sql.exec(
          "DELETE FROM next_calls WHERE seq<=? AND ack IS NOT NULL",
          cp.settledThroughEdgeSequence,
        );
      this.save({
        checkpoint: cp,
        lastAdmit: old?.lastAdmit,
        nextSequence:
          old && old.checkpoint.epoch === cp.epoch ? old.nextSequence : 0,
        freeze: pages[0]!.freeze,
        sealed:
          cp.gateState === "closed" ||
          cp.gateState === "maintenance" ||
          (old?.checkpoint.epoch === cp.epoch ? old.sealed : false),
        ...(old?.checkpoint.epoch === cp.epoch && old.ack
          ? { ack: old.ack }
          : {}),
      });
    });
  }
  private async refreshCheckpoint(owner: string, signal: AbortSignal) {
    if (this.checkpointPending) return this.checkpointPending;
    this.checkpointPending = this.fillCheckpoint(owner, signal);
    try {
      await this.checkpointPending;
    } finally {
      this.checkpointPending = undefined;
    }
  }
  private async fillCheckpoint(owner: string, signal: AbortSignal) {
    const bootstrapId = await this.ctx.storage.get<string>("bootstrapId");
    if (!bootstrapId) throw new Error("Wallet recovery required");
    if (!(await this.ctx.storage.get<boolean>("activated"))) {
      const response = await fetch(
        new URL("/wallet-activate", this.env.NEXT_CONVEX_SITE_URL),
        {
          method: "POST",
          headers: {
            "x-internal-secret": this.env.GATEWAY_INTERNAL_SECRET!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            clerkOrgId: owner,
            deploymentId: this.env.NEXT_DEPLOYMENT_ID,
            bootstrapId,
          }),
          signal,
        },
      );
      if (!response.ok) throw new Error("Wallet activation unavailable");
      await this.ctx.storage.put("activated", true);
    }
    const pages: WalletPage[] = [];
    let cursor: string | undefined;
    do {
      const p = walletPage.parse(
        (await pull(this.env, "wallet", owner, cursor, 0, signal)).payload,
      );
      if (
        pages.length &&
        (p.checkpoint.generationId !== pages[0]!.checkpoint.generationId ||
          p.checkpoint.page !== pages.length)
      )
        throw new Error("Mixed checkpoint generation");
      pages.push(p);
      if (
        pages.length === 1 &&
        p.checkpoint.generationId === this.state()?.checkpoint.generationId
      )
        break;
      cursor = p.checkpoint.nextCursor;
      if (pages.length > 1000) throw new Error("Checkpoint capacity exceeded");
    } while (cursor);
    signal.throwIfAborted();
    await this.ctx.blockConcurrencyWhile(async () =>
      this.install(pages, bootstrapId),
    );
  }
  private prune() {
    const now = Date.now(),
      day = new Date(now).toISOString().slice(0, 10),
      month = day.slice(0, 7);
    this.ctx.storage.sql.exec(
      "DELETE FROM next_counters WHERE (id LIKE 'rate:%' AND value + (? - at) / 1000.0 >= 60) OR (id LIKE 'free:%' AND substr(id,-10) < ?) OR (id LIKE 'budget:%' AND substr(id,-7) < ?)",
      now,
      day,
      month,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM next_failures WHERE NOT EXISTS (SELECT 1 FROM next_calls WHERE next_failures.ref = 'proof:' || next_calls.ref OR next_failures.ref = json_extract(next_calls.data, '$.settleRefId'))",
    );
  }
  private failure(ref: string, evidence: string, reason: string) {
    const prior = this.ctx.storage.sql
      .exec<{ reason: string }>(
        "SELECT reason FROM next_failures WHERE ref=?",
        ref,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO next_failures VALUES(?,?,?)",
      ref,
      evidence,
      reason,
    );
    if (prior?.reason !== reason)
      console.error(
        JSON.stringify({
          event: "next_settlement_failure",
          deploymentId: this.env.NEXT_DEPLOYMENT_ID,
          refId: ref,
          reason,
        }),
      );
  }
  async alarm() {
    const owner = await this.ctx.storage.get<string>("owner");
    if (!owner) return;
    try {
      for (const row of this.calls())
        if (!row.final && row.deadline <= Date.now()) {
          const a = JSON.parse(row.data) as Admission;
          await this.finalize(
            a.reservationId,
            502,
            Date.now() - a.admittedAt,
            true,
          );
        }
      const ready: RecordRow[] = [];
      for (const r of this.calls()) {
        if (!r.final) break;
        if (!r.ack) ready.push(r);
        if (ready.length === 100) break;
      }
      if (ready.length) {
        const response = await fetch(
          new URL("/ingest-usage", this.env.NEXT_CONVEX_SITE_URL),
          {
            method: "POST",
            headers: {
              "x-internal-secret": this.env.GATEWAY_INTERNAL_SECRET!,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              events: ready.map((r) => JSON.parse(r.final!)),
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) throw new Error("Ingest unavailable");
        const body = z
          .object({ results: z.array(settlementOutcome) })
          .parse(await response.json());
        this.ctx.storage.transactionSync(() => {
          for (const result of body.results) {
            const row = ready.find(
              (r) =>
                (JSON.parse(r.data) as Admission).settleRefId === result.refId,
            );
            if (!row) throw new Error("Unexpected ACK");
            const admitted = JSON.parse(row.data) as Admission;
            const current = this.ctx.storage.sql
              .exec<{ ack: string | null }>(
                "SELECT ack FROM next_calls WHERE seq=? AND ref=?",
                row.seq,
                admitted.reservationId,
              )
              .toArray()[0];
            if (!current || current.ack) continue;
            if (result.status === "rejected") {
              if (!result.retryable)
                this.failure(result.refId, row.final!, result.reason);
            } else {
              this.ctx.storage.sql.exec(
                "UPDATE next_calls SET ack=? WHERE seq=? AND ref=?",
                result.status,
                row.seq,
                admitted.reservationId,
              );
              if (result.status === "exception") {
                this.failure(result.refId, row.final!, "settlement_exception");
                const a = JSON.parse(row.data) as Admission,
                  f = JSON.parse(row.final!) as Settlement,
                  id = `budget:${a.keyFamilyId}:${a.budgetPeriod}`;
                this.setCounter(
                  id,
                  Math.max(0, this.counter(id).value - f.credits),
                );
              }
            }
          }
        });
      }
      await this.refreshCheckpoint(owner, AbortSignal.timeout(10_000));
      let s = this.state()!;
      if (s.freeze && !this.calls().length) {
        if (!s.ack) {
          const ack = {
            ...s.freeze,
            edgeFinalSequence: s.nextSequence,
            settledThroughEdgeSequence: s.checkpoint.settledThroughEdgeSequence,
            sealedAt: Date.now(),
          };
          if (ack.edgeFinalSequence !== ack.settledThroughEdgeSequence)
            throw new Error("Drain gap");
          s = { ...s, sealed: true, ack };
          this.save(s);
        }
        const response = await fetch(
          new URL("/wallet-drain", this.env.NEXT_CONVEX_SITE_URL),
          {
            method: "POST",
            headers: {
              "x-internal-secret": this.env.GATEWAY_INTERNAL_SECRET!,
              "content-type": "application/json",
            },
            body: JSON.stringify(s.ack),
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) throw new Error("Drain unavailable");
      }
    } catch {
      /* Durable calls, finals and close state survive; no timeout ACK. */
    } finally {
      this.prune();
      const state = this.state(),
        now = Date.now();
      const lastActivity = Math.max(
        state?.lastAdmit ?? 0,
        (await this.ctx.storage.get<number>("lastWake")) ?? 0,
      );
      if (
        this.calls().length ||
        state?.freeze ||
        state?.checkpoint.gateState === "closing" ||
        now - lastActivity < 5 * 60_000
      )
        await this.ctx.storage.setAlarm(now + 15_000);
      else await this.ctx.storage.deleteAlarm();
    }
  }
}
