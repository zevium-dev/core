declare namespace Cloudflare {
  interface Env {
    WALLET: DurableObjectNamespace;
    CLERK_SECRET_KEY?: string;
    CONVEX_URL?: string;
    /** Convex .convex.site origin for httpActions (ingest-usage). */
    CONVEX_SITE_URL?: string;
    CONVEX_DEPLOY_KEY?: string;
    GATEWAY_INTERNAL_SECRET?: string;
    GATEWAY_TEST_MODE?: string;
    ZEVIUM_GIT_SHA?: string;
    ZEVIUM_GATEWAY_DEPLOYMENT_ID?: string;
    ZEVIUM_DEPLOYED_AT?: string;
    ZEVIUM_DEPLOYMENT_MODE?: string;
  }
}

interface Env extends Cloudflare.Env {}
