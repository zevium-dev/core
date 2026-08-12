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
import type * as cronTasks from "../cronTasks.js";
import type * as crons from "../crons.js";
import type * as earnings from "../earnings.js";
import type * as financeMigration from "../financeMigration.js";
import type * as http from "../http.js";
import type * as keySettings from "../keySettings.js";
import type * as keyVerification from "../keyVerification.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_credentialCrypto from "../lib/credentialCrypto.js";
import type * as lib_financeMigrationGate from "../lib/financeMigrationGate.js";
import type * as lib_funding from "../lib/funding.js";
import type * as lib_keysetCursor from "../lib/keysetCursor.js";
import type * as lib_notifications from "../lib/notifications.js";
import type * as lib_paymentStatus from "../lib/paymentStatus.js";
import type * as lib_publicRoutes from "../lib/publicRoutes.js";
import type * as lib_publisherLedger from "../lib/publisherLedger.js";
import type * as lib_qualityContract from "../lib/qualityContract.js";
import type * as lib_settlementIdentity from "../lib/settlementIdentity.js";
import type * as lib_validate from "../lib/validate.js";
import type * as lib_webhookDelivery from "../lib/webhookDelivery.js";
import type * as lib_webhookTransport from "../lib/webhookTransport.js";
import type * as notifications from "../notifications.js";
import type * as organizations from "../organizations.js";
import type * as payouts from "../payouts.js";
import type * as projects from "../projects.js";
import type * as publishReadiness from "../publishReadiness.js";
import type * as publishReadinessAction from "../publishReadinessAction.js";
import type * as quality from "../quality.js";
import type * as qualityProbeAction from "../qualityProbeAction.js";
import type * as registryRollout from "../registryRollout.js";
import type * as registrySync from "../registrySync.js";
import type * as reviews from "../reviews.js";
import type * as search from "../search.js";
import type * as specs from "../specs.js";
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
  cronTasks: typeof cronTasks;
  crons: typeof crons;
  earnings: typeof earnings;
  financeMigration: typeof financeMigration;
  http: typeof http;
  keySettings: typeof keySettings;
  keyVerification: typeof keyVerification;
  "lib/auth": typeof lib_auth;
  "lib/credentialCrypto": typeof lib_credentialCrypto;
  "lib/financeMigrationGate": typeof lib_financeMigrationGate;
  "lib/funding": typeof lib_funding;
  "lib/keysetCursor": typeof lib_keysetCursor;
  "lib/notifications": typeof lib_notifications;
  "lib/paymentStatus": typeof lib_paymentStatus;
  "lib/publicRoutes": typeof lib_publicRoutes;
  "lib/publisherLedger": typeof lib_publisherLedger;
  "lib/qualityContract": typeof lib_qualityContract;
  "lib/settlementIdentity": typeof lib_settlementIdentity;
  "lib/validate": typeof lib_validate;
  "lib/webhookDelivery": typeof lib_webhookDelivery;
  "lib/webhookTransport": typeof lib_webhookTransport;
  notifications: typeof notifications;
  organizations: typeof organizations;
  payouts: typeof payouts;
  projects: typeof projects;
  publishReadiness: typeof publishReadiness;
  publishReadinessAction: typeof publishReadinessAction;
  quality: typeof quality;
  qualityProbeAction: typeof qualityProbeAction;
  registryRollout: typeof registryRollout;
  registrySync: typeof registrySync;
  reviews: typeof reviews;
  search: typeof search;
  specs: typeof specs;
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

export declare const components: {};
