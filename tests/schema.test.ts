import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { lotCompatibility } from "../contracts";
import { NOW } from "./fixtures";

const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
};
// Synthetic references use convex-test's ID format. These test schema, not referential integrity.
const id = <T extends TableNames>(table: T): Id<T> => `10000${table}` as Id<T>;
const entry = {
  walletId: id("wallets"),
  refId: "entry",
  sequence: 1,
  balanceAfter: 0,
  createdAt: NOW,
  immutableFingerprint: "fixture",
};
const source = { lotId: id("fundingLots"), originLotId: id("fundingLots") };

describe("accounting schema invariants", () => {
  it("requires every variant's accounting references and rejects catch-all fields", async () => {
    const t = convexTest(schema, modules);
    const valid = [
      ...["grant", "promo"].map((kind) => ({
        ...entry,
        ...source,
        kind,
        amount: 1,
      })),
      { ...entry, kind: "usage", amount: -1, usageEventId: id("usageEvents") },
      ...["reversal", "restoration"].flatMap((kind) => [
        {
          ...entry,
          ...source,
          kind,
          amount: -1,
          adjustment: { kind: "payment", id: id("paymentAdjustments") },
        },
        {
          ...entry,
          ...source,
          kind,
          amount: -1,
          adjustment: { kind: "admin", ref: "admin:1" },
        },
      ]),
      { ...entry, ...source, kind: "expiry", amount: -1, breakageCredits: 1 },
      {
        ...entry,
        kind: "lot_move",
        amount: 0,
        fromLotId: id("fundingLots"),
        toLotId: "20000fundingLots",
        originLotId: id("fundingLots"),
        sourceRef: "payment:1",
        movedCredits: 1,
        reason: "dust_merge",
        mergeId: "merge:1",
      },
    ];
    // Deliberately bypass compile-time checks to exercise runtime schema rejection.
    const insert = (value: unknown) =>
      t.run((ctx) =>
        ctx.db.insert(
          "walletEntries",
          value as WithoutSystemFields<Doc<"walletEntries">>,
        ),
      );
    for (const value of valid) {
      await expect(insert(value)).resolves.toBeTruthy();
      const required =
        value.kind === "lot_move"
          ? ["sourceRef", "originLotId"]
          : value.kind === "usage"
            ? ["usageEventId"]
            : [
                "lotId",
                "originLotId",
                ...(["reversal", "restoration"].includes(value.kind)
                  ? ["adjustment"]
                  : value.kind === "expiry"
                    ? ["breakageCredits"]
                    : []),
              ];
      for (const key of required) {
        const incomplete: Record<string, unknown> = { ...value };
        delete incomplete[key];
        await expect(insert(incomplete)).rejects.toThrow("Validator");
      }
    }
    await expect(
      insert({
        ...entry,
        ...source,
        kind: "reversal",
        amount: -1,
        adjustmentId: id("paymentAdjustments"),
      }),
    ).rejects.toThrow("Validator");
    await expect(
      insert({
        ...entry,
        ...source,
        kind: "reversal",
        amount: -1,
        adjustment: { kind: "admin", id: id("paymentAdjustments") },
      }),
    ).rejects.toThrow("Validator");
    const facts = await t.run((ctx) =>
      ctx.db
        .query("walletEntries")
        .withIndex("by_admin_adjustment", (q) =>
          q
            .eq("walletId", entry.walletId)
            .eq("adjustment.kind", "admin")
            .eq("adjustment.ref", "admin:1"),
        )
        .collect(),
    );
    expect(facts.map((fact) => fact.kind)).toEqual(["reversal", "restoration"]);
  });

  it("rejects refund/dispute status crossover", async () => {
    const t = convexTest(schema, modules);
    const common = {
      paymentId: id("payments"),
      providerSourceRef: "provider:1",
      principalCents: 1,
      feeCents: 0,
      requestedCredits: 100,
      effectiveCredits: 100,
      fundsWithdrawn: false,
      fundsReinstated: false,
      revision: 1,
      appliedWalletCredits: 0,
      appliedPublisherCredits: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const statuses = {
      refund: ["pending", "requires_action", "succeeded", "failed", "canceled"],
      dispute: ["open", "won", "lost"],
    };
    for (const kind of ["refund", "dispute"] as const) {
      for (const status of [...statuses.refund, ...statuses.dispute]) {
        // Intentionally exercise invalid runtime combinations.
        const write = t.run((ctx) =>
          ctx.db.insert("paymentAdjustments", {
            ...common,
            kind,
            status,
          } as WithoutSystemFields<Doc<"paymentAdjustments">>),
        );
        if (statuses[kind].includes(status))
          await expect(write).resolves.toBeTruthy();
        else await expect(write).rejects.toThrow("Validator");
      }
    }
  });

  it("separates lifetime totals from consumer-project eligibility by kind and index", async () => {
    const t = convexTest(schema, modules);
    const eligibility = {
      kind: "lifetime_consumer_project" as const,
      consumerOrganizationId: id("organizations"),
      projectId: id("projects"),
      firstSuccessAt: NOW,
      lastSuccessAt: NOW,
      successfulCalls: 1,
      noticeRevision: 1,
      updatedAt: NOW,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("usageRollups", {
        kind: "lifetime",
        scope: "consumer",
        scopeId: "org",
        dimension: "total",
        dimensionKey: "all",
        shard: 0,
        calls: 1,
        grossCredits: 1,
        netAtoms: 9500,
        pendingRiskAtoms: 9500,
        reversedAtoms: 0,
        failedAtoms: 0,
        updatedAt: NOW,
      });
      await ctx.db.insert("usageRollups", eligibility);
    });
    await expect(
      t.run((ctx) =>
        ctx.db.insert("usageRollups", {
          ...eligibility,
          kind: "lifetime",
        } as unknown as WithoutSystemFields<Doc<"usageRollups">>),
      ),
    ).rejects.toThrow("Validator");
    const rows = await t.run((ctx) =>
      ctx.db
        .query("usageRollups")
        .withIndex("by_consumer_project", (q) =>
          q
            .eq("kind", "lifetime_consumer_project")
            .eq("consumerOrganizationId", eligibility.consumerOrganizationId)
            .eq("projectId", eligibility.projectId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("lifetime_consumer_project");
  });

  it("selects newest compatible lot using an exact expiry index prefix", async () => {
    const t = convexTest(schema, modules);
    const compatibility = lotCompatibility.parse({
      walletId: id("wallets"),
      expiryClass: `at:${NOW}`,
      expiresAt: NOW,
      sourceKind: "payment",
      refundable: true,
      priority: 1,
    });
    const base = {
      ...compatibility,
      walletId: id("wallets"),
      spendable: true,
      grantedCredits: 1,
      movedInCredits: 0,
      movedOutCredits: 0,
      remainingCredits: 1,
      consumedCredits: 0,
      reversedCredits: 0,
      expiredCredits: 0,
      state: "available" as const,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("fundingLots", {
        ...base,
        sourceRef: "older",
        createdAt: 1,
      });
      await ctx.db.insert("fundingLots", {
        ...base,
        sourceRef: "newest-compatible",
        createdAt: 2,
      });
      await ctx.db.insert("fundingLots", {
        ...base,
        sourceRef: "newer-wrong-deadline",
        expiryClass: `at:${NOW + 1}`,
        expiresAt: NOW + 1,
        createdAt: 3,
      });
    });
    const target = await t.run((ctx) =>
      ctx.db
        .query("fundingLots")
        .withIndex("by_merge_target", (q) =>
          q
            .eq("walletId", base.walletId)
            .eq("expiryClass", compatibility.expiryClass)
            .eq("sourceKind", compatibility.sourceKind)
            .eq("refundable", compatibility.refundable)
            .eq("priority", compatibility.priority),
        )
        .order("desc")
        .first(),
    );
    expect(target?.sourceRef).toBe("newest-compatible");
  });
});

describe("durable notification and quarantine facts", () => {
  it("indexes org-user preferences and receipts by notification revision/user", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const clerkOrgId of ["org_a", "org_b"])
        await ctx.db.insert("notificationPreferences", {
          clerkOrgId,
          clerkUserId: "user",
          emailOptOut: clerkOrgId === "org_a",
        });
      for (const revision of [1, 2])
        await ctx.db.insert("notificationEmailDeliveries", {
          notificationId: id("notifications"),
          revision,
          clerkUserId: "user",
          emailId: `email_${revision}`,
        });
    });
    const preference = await t.run((ctx) =>
      ctx.db
        .query("notificationPreferences")
        .withIndex("by_org_user", (q) =>
          q.eq("clerkOrgId", "org_b").eq("clerkUserId", "user"),
        )
        .unique(),
    );
    expect(preference?.emailOptOut).toBe(false);
    const receipt = await t.run((ctx) =>
      ctx.db
        .query("notificationEmailDeliveries")
        .withIndex("by_notification_revision_user", (q) =>
          q
            .eq("notificationId", id("notifications"))
            .eq("revision", 1)
            .eq("clerkUserId", "user"),
        )
        .unique(),
    );
    expect(receipt?.emailId).toBe("email_1");
  });

  it("keeps unowned provider cases and paginated evidence outside ledger rows", async () => {
    const t = convexTest(schema, modules);
    const caseIds = await t.run(async (ctx) => {
      const ids = [];
      for (const kind of [
        "foreign_stripe_event",
        "transfer_orphan",
        "account_create",
      ] as const)
        ids.push(
          await ctx.db.insert("financeReconciliationCases", {
            rowKind: "case",
            kind,
            status: "quarantined",
            reason: "fixture",
            operationId: kind,
            candidateCount: 3,
            attempts: 1,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        );
      for (const caseId of ids) {
        for (const value of ["candidate_a", "candidate_b", "candidate_c"])
          await ctx.db.insert("financeReconciliationCases", {
            rowKind: "candidate",
            caseId,
            value,
            createdAt: NOW,
          });
        await ctx.db.insert("financeReconciliationCases", {
          rowKind: "provider_request",
          caseId,
          value: "request_a",
          createdAt: NOW,
        });
      }
      return ids;
    });
    const page = await t.run((ctx) =>
      ctx.db
        .query("financeReconciliationCases")
        .withIndex("by_case_evidence", (q) =>
          q.eq("caseId", caseIds[0]).eq("rowKind", "candidate"),
        )
        .paginate({ numItems: 2, cursor: null }),
    );
    expect(page.page).toHaveLength(2);
    expect(page.isDone).toBe(false);
    const rest = await t.run((ctx) =>
      ctx.db
        .query("financeReconciliationCases")
        .withIndex("by_case_evidence", (q) =>
          q.eq("caseId", caseIds[0]).eq("rowKind", "candidate"),
        )
        .paginate({ numItems: 2, cursor: page.continueCursor }),
    );
    expect(rest.page).toHaveLength(1);
    const queue = await t.run((ctx) =>
      ctx.db
        .query("financeReconciliationCases")
        .withIndex("by_status_updated", (q) =>
          q.eq("rowKind", "case").eq("status", "quarantined"),
        )
        .collect(),
    );
    expect(queue).toHaveLength(3);
  });
});
