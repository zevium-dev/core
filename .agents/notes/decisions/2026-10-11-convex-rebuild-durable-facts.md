# Preserve durable facts in the Convex rebuild

Status: accepted; PR 1 schema implemented, domain workers pending.
Date: 2026-10-11.
Scope: #353, PR #436.

The owner authorized raising the rebuild table count to preserve baseline notification preferences, permanent email enqueue receipts, and finance reconciliation/quarantine facts now, instead of deferring their storage decision to PR 6.

The isolated schema has 34 application tables plus four rate-limiter component tables (38 physical tables excluding Convex system tables). Add `notificationPreferences`, `notificationEmailDeliveries`, and `financeReconciliationCases`. Preferences belong to org/user pairs; receipts survive provider retention; foreign/unowned finance facts cannot require an owned payment or transfer. Reconciliation evidence lives in indexed child rows within its table, with no growing arrays. No production schema or shared deployment changes.

Implementation choice authorized by the review brief: negative admin adjustments use immutable per-source `walletEntries` reversal/restoration facts grouped by server-issued admin ref. No synthetic payment fact or extra admin table. The later wallet layer owns atomic bounded application after drain and changed-fact replay rejection.

The 32-slice admission limit counts original sources even within merged lots. Dust merges reduce container count, not source-slice count. Org-wallet acceptance remains as recorded in the original funding decision.

[Schema, indexes, invariants and exported shape handoff](../architecture/convex-rebuild.md#pr-1-implementation-and-handoff--2026-10-11).
