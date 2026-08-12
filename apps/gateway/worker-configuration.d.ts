declare namespace Cloudflare {
  interface Env {
    WALLET: DurableObjectNamespace;
    CONTROL?: DurableObjectNamespace;
    CLERK_SECRET_KEY?: string;
    CONVEX_URL?: string;
    /** Convex .convex.site origin for httpActions (ingest-usage). */
    CONVEX_SITE_URL?: string;
    CONVEX_DEPLOY_KEY?: string;
    GATEWAY_INTERNAL_SECRET?: string;
    GATEWAY_TEST_MODE?: string;
  }
}

interface Env extends Cloudflare.Env {}
