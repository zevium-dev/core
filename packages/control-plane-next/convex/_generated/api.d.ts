/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounting from "../accounting.js";
import type * as admin from "../admin.js";
import type * as analytics from "../analytics.js";
import type * as billing from "../billing.js";
import type * as catalogue from "../catalogue.js";
import type * as clerkWebhooks from "../clerkWebhooks.js";
import type * as connect from "../connect.js";
import type * as cronTasks from "../cronTasks.js";
import type * as crons from "../crons.js";
import type * as earnings from "../earnings.js";
import type * as edgeMaintenance from "../edgeMaintenance.js";
import type * as edgeSnapshots from "../edgeSnapshots.js";
import type * as http from "../http.js";
import type * as keyRecovery from "../keyRecovery.js";
import type * as keySettings from "../keySettings.js";
import type * as keyVerification from "../keyVerification.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_billingRead from "../lib/billingRead.js";
import type * as lib_catalogue from "../lib/catalogue.js";
import type * as lib_credentialCrypto from "../lib/credentialCrypto.js";
import type * as lib_drafts from "../lib/drafts.js";
import type * as lib_dto from "../lib/dto.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_keyProjection from "../lib/keyProjection.js";
import type * as lib_keys from "../lib/keys.js";
import type * as lib_notificationEmail from "../lib/notificationEmail.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as lib_publicRoutes from "../lib/publicRoutes.js";
import type * as lib_qualityContract from "../lib/qualityContract.js";
import type * as lib_readRollups from "../lib/readRollups.js";
import type * as lib_specPolicy from "../lib/specPolicy.js";
import type * as lib_stripe from "../lib/stripe.js";
import type * as lib_webhookDelivery from "../lib/webhookDelivery.js";
import type * as lib_webhookTransport from "../lib/webhookTransport.js";
import type * as lifecycleNotices from "../lifecycleNotices.js";
import type * as money_adjustments from "../money/adjustments.js";
import type * as money_barrier from "../money/barrier.js";
import type * as money_dust from "../money/dust.js";
import type * as money_financialRollups from "../money/financialRollups.js";
import type * as money_lots from "../money/lots.js";
import type * as money_publisherLedger from "../money/publisherLedger.js";
import type * as money_reconciliationCases from "../money/reconciliationCases.js";
import type * as money_rollups from "../money/rollups.js";
import type * as money_settle from "../money/settle.js";
import type * as money_sourceAdjustments from "../money/sourceAdjustments.js";
import type * as money_throughput from "../money/throughput.js";
import type * as money_transfers from "../money/transfers.js";
import type * as money_walletLedger from "../money/walletLedger.js";
import type * as notificationEmail from "../notificationEmail.js";
import type * as notificationEmailAction from "../notificationEmailAction.js";
import type * as notifications from "../notifications.js";
import type * as operators from "../operators.js";
import type * as organizations from "../organizations.js";
import type * as payouts from "../payouts.js";
import type * as projects from "../projects.js";
import type * as publishReadiness from "../publishReadiness.js";
import type * as publishReadinessAction from "../publishReadinessAction.js";
import type * as quality from "../quality.js";
import type * as qualityProbeAction from "../qualityProbeAction.js";
import type * as reviews from "../reviews.js";
import type * as schema_common from "../schema/common.js";
import type * as schema_identity from "../schema/identity.js";
import type * as schema_read from "../schema/read.js";
import type * as schema_settlement from "../schema/settlement.js";
import type * as schema_wallet from "../schema/wallet.js";
import type * as search from "../search.js";
import type * as specImportLimits from "../specImportLimits.js";
import type * as specs from "../specs.js";
import type * as stripeEvents from "../stripeEvents.js";
import type * as upstreamCredentials from "../upstreamCredentials.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";
import type * as wallets from "../wallets.js";
import type * as webhookDeliveryAction from "../webhookDeliveryAction.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounting: typeof accounting;
  admin: typeof admin;
  analytics: typeof analytics;
  billing: typeof billing;
  catalogue: typeof catalogue;
  clerkWebhooks: typeof clerkWebhooks;
  connect: typeof connect;
  cronTasks: typeof cronTasks;
  crons: typeof crons;
  earnings: typeof earnings;
  edgeMaintenance: typeof edgeMaintenance;
  edgeSnapshots: typeof edgeSnapshots;
  http: typeof http;
  keyRecovery: typeof keyRecovery;
  keySettings: typeof keySettings;
  keyVerification: typeof keyVerification;
  "lib/auth": typeof lib_auth;
  "lib/billingRead": typeof lib_billingRead;
  "lib/catalogue": typeof lib_catalogue;
  "lib/credentialCrypto": typeof lib_credentialCrypto;
  "lib/drafts": typeof lib_drafts;
  "lib/dto": typeof lib_dto;
  "lib/identity": typeof lib_identity;
  "lib/keyProjection": typeof lib_keyProjection;
  "lib/keys": typeof lib_keys;
  "lib/notificationEmail": typeof lib_notificationEmail;
  "lib/notifications": typeof lib_notifications;
  "lib/publicRoutes": typeof lib_publicRoutes;
  "lib/qualityContract": typeof lib_qualityContract;
  "lib/readRollups": typeof lib_readRollups;
  "lib/specPolicy": typeof lib_specPolicy;
  "lib/stripe": typeof lib_stripe;
  "lib/webhookDelivery": typeof lib_webhookDelivery;
  "lib/webhookTransport": typeof lib_webhookTransport;
  lifecycleNotices: typeof lifecycleNotices;
  "money/adjustments": typeof money_adjustments;
  "money/barrier": typeof money_barrier;
  "money/dust": typeof money_dust;
  "money/financialRollups": typeof money_financialRollups;
  "money/lots": typeof money_lots;
  "money/publisherLedger": typeof money_publisherLedger;
  "money/reconciliationCases": typeof money_reconciliationCases;
  "money/rollups": typeof money_rollups;
  "money/settle": typeof money_settle;
  "money/sourceAdjustments": typeof money_sourceAdjustments;
  "money/throughput": typeof money_throughput;
  "money/transfers": typeof money_transfers;
  "money/walletLedger": typeof money_walletLedger;
  notificationEmail: typeof notificationEmail;
  notificationEmailAction: typeof notificationEmailAction;
  notifications: typeof notifications;
  operators: typeof operators;
  organizations: typeof organizations;
  payouts: typeof payouts;
  projects: typeof projects;
  publishReadiness: typeof publishReadiness;
  publishReadinessAction: typeof publishReadinessAction;
  quality: typeof quality;
  qualityProbeAction: typeof qualityProbeAction;
  reviews: typeof reviews;
  "schema/common": typeof schema_common;
  "schema/identity": typeof schema_identity;
  "schema/read": typeof schema_read;
  "schema/settlement": typeof schema_settlement;
  "schema/wallet": typeof schema_wallet;
  search: typeof search;
  specImportLimits: typeof specImportLimits;
  specs: typeof specs;
  stripeEvents: typeof stripeEvents;
  upstreamCredentials: typeof upstreamCredentials;
  usage: typeof usage;
  users: typeof users;
  wallets: typeof wallets;
  webhookDeliveryAction: typeof webhookDeliveryAction;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
};
