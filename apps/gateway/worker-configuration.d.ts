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
    ZEVIUM_RELEASE?: string;
    CF_VERSION_METADATA?: {
      id: string;
      tag: string;
      timestamp: string;
    };
  }
}

interface Env extends Cloudflare.Env {}
