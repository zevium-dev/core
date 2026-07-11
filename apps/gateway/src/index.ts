import { WalletDO } from "./wallet";

export { WalletDO };

export interface Env {
  WALLET: DurableObjectNamespace<WalletDO>;
}

/**
 * Minimal Worker: routes /wallet/:orgId/* to the org's WalletDO.
 * Body/path after /wallet/:orgId is forwarded to the DO's fetch router.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // /wallet/:orgId[/*]
    if (parts[0] === "wallet" && parts[1]) {
      const orgId = parts[1];
      const rest = "/" + parts.slice(2).join("/");
      const id = env.WALLET.idFromName(orgId);
      const stub = env.WALLET.get(id);

      const doUrl = new URL(rest === "/" ? "/state" : rest, url.origin);
      doUrl.search = url.search;

      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.arrayBuffer();
      }

      return stub.fetch(new Request(doUrl.toString(), init));
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "wallet-do-spike" });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
