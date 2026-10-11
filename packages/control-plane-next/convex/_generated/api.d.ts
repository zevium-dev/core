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
import type * as lib_auth from "../lib/auth.js";
import type * as schema_common from "../schema/common.js";
import type * as schema_identity from "../schema/identity.js";
import type * as schema_read from "../schema/read.js";
import type * as schema_settlement from "../schema/settlement.js";
import type * as schema_wallet from "../schema/wallet.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounting: typeof accounting;
  "lib/auth": typeof lib_auth;
  "schema/common": typeof schema_common;
  "schema/identity": typeof schema_identity;
  "schema/read": typeof schema_read;
  "schema/settlement": typeof schema_settlement;
  "schema/wallet": typeof schema_wallet;
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
