import { query } from "./_generated/server";
import { DEPLOYMENT_MANIFEST } from "./deploymentManifest.generated";

/** Public, non-secret immutable build identity used by staging proof drills. */
export const get = query({
  args: {},
  handler: () => DEPLOYMENT_MANIFEST,
});
