import type { WalletDO } from "./src/wallet";

declare namespace Cloudflare {
  interface Env {
    WALLET: DurableObjectNamespace<WalletDO>;
    CLERK_SECRET_KEY?: string;
    CONVEX_URL?: string;
    GATEWAY_TEST_MODE?: string;
  }
}

interface Env extends Cloudflare.Env {}
