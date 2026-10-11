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
import type * as billing from "../billing.js";
import type * as clerkWebhooks from "../clerkWebhooks.js";
import type * as connect from "../connect.js";
import type * as crons from "../crons.js";
import type * as edgeMaintenance from "../edgeMaintenance.js";
import type * as edgeSnapshots from "../edgeSnapshots.js";
import type * as http from "../http.js";
import type * as keyRecovery from "../keyRecovery.js";
import type * as keySettings from "../keySettings.js";
import type * as keyVerification from "../keyVerification.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_credentialCrypto from "../lib/credentialCrypto.js";
import type * as lib_drafts from "../lib/drafts.js";
import type * as lib_dto from "../lib/dto.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_keyProjection from "../lib/keyProjection.js";
import type * as lib_keys from "../lib/keys.js";
import type * as lib_publicRoutes from "../lib/publicRoutes.js";
import type * as lib_specPolicy from "../lib/specPolicy.js";
import type * as lib_stripe from "../lib/stripe.js";
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
import type * as organizations from "../organizations.js";
import type * as payouts from "../payouts.js";
import type * as projects from "../projects.js";
import type * as publishReadiness from "../publishReadiness.js";
import type * as schema_common from "../schema/common.js";
import type * as schema_identity from "../schema/identity.js";
import type * as schema_read from "../schema/read.js";
import type * as schema_settlement from "../schema/settlement.js";
import type * as schema_wallet from "../schema/wallet.js";
import type * as specs from "../specs.js";
import type * as stripeEvents from "../stripeEvents.js";
import type * as upstreamCredentials from "../upstreamCredentials.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";
import type * as wallets from "../wallets.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounting: typeof accounting;
  billing: typeof billing;
  clerkWebhooks: typeof clerkWebhooks;
  connect: typeof connect;
  crons: typeof crons;
  edgeMaintenance: typeof edgeMaintenance;
  edgeSnapshots: typeof edgeSnapshots;
  http: typeof http;
  keyRecovery: typeof keyRecovery;
  keySettings: typeof keySettings;
  keyVerification: typeof keyVerification;
  "lib/auth": typeof lib_auth;
  "lib/credentialCrypto": typeof lib_credentialCrypto;
  "lib/drafts": typeof lib_drafts;
  "lib/dto": typeof lib_dto;
  "lib/identity": typeof lib_identity;
  "lib/keyProjection": typeof lib_keyProjection;
  "lib/keys": typeof lib_keys;
  "lib/publicRoutes": typeof lib_publicRoutes;
  "lib/specPolicy": typeof lib_specPolicy;
  "lib/stripe": typeof lib_stripe;
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
  organizations: typeof organizations;
  payouts: typeof payouts;
  projects: typeof projects;
  publishReadiness: typeof publishReadiness;
  "schema/common": typeof schema_common;
  "schema/identity": typeof schema_identity;
  "schema/read": typeof schema_read;
  "schema/settlement": typeof schema_settlement;
  "schema/wallet": typeof schema_wallet;
  specs: typeof specs;
  stripeEvents: typeof stripeEvents;
  upstreamCredentials: typeof upstreamCredentials;
  usage: typeof usage;
  users: typeof users;
  wallets: typeof wallets;
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
};
