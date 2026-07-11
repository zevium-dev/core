declare namespace Cloudflare {
  interface Env {
    WALLET: DurableObjectNamespace;
    CLERK_SECRET_KEY?: string;
    CONVEX_URL?: string;
    CONVEX_DEPLOY_KEY?: string;
    GATEWAY_INTERNAL_SECRET?: string;
    GATEWAY_TEST_MODE?: string;
  }
}

interface Env extends Cloudflare.Env {}
