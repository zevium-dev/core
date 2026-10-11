export * from "@zevium/shared/edge/read";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api";
/** Generated result types are shared with the paired web build, never cast to legacy bindings. */
export type ReadContracts = {
  catalogue: FunctionReturnType<typeof api.catalogue.listPublic>;
  quality: FunctionReturnType<typeof api.quality.getPublisherQuality>;
  reviews: FunctionReturnType<typeof api.reviews.listPublic>;
  notifications: FunctionReturnType<typeof api.notifications.listForOrg>;
  analytics: FunctionReturnType<typeof api.analytics.projectAnalytics>;
  earnings: FunctionReturnType<typeof api.earnings.forOrg>;
  financeCases: FunctionReturnType<
    typeof api.admin.listFinanceReconciliationCases
  >;
};
