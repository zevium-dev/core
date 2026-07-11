import type { WalletDO } from "./src/wallet";

declare namespace Cloudflare {
  interface Env {
    WALLET: DurableObjectNamespace<WalletDO>;
  }
}

interface Env extends Cloudflare.Env {}
