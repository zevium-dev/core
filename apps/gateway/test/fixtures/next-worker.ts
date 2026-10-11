// Local acceptance entrypoint only; never referenced by deployment configuration.
import worker, { type Env } from "../../src/index";
import { EdgeSnapshotDO as SnapshotBase } from "../../src/next/snapshots";
import { NextWalletDO as WalletBase } from "../../src/next/wallet";
export { EdgeOAuthDO } from "../../src/next/oauth";
export class EdgeSnapshotDO extends SnapshotBase {
  async refresh() {
    await this.alarm();
  }
  async expire() {
    const p = await this.ctx.storage.get<Record<string, unknown>>("current");
    if (p) await this.ctx.storage.put("current", { ...p, expiresAt: 1 });
  }
}
export class NextWalletDO extends WalletBase {
  async refresh() {
    await this.alarm();
  }
  inspect() {
    return {
      state: this.ctx.storage.sql.exec("SELECT * FROM next_state").toArray(),
      calls: this.ctx.storage.sql.exec("SELECT * FROM next_calls").toArray(),
    };
  }
  expireHolds() {
    this.ctx.storage.sql.exec(
      "UPDATE next_calls SET deadline=0 WHERE final IS NULL",
    );
  }
}
type TestEnv = Env & {
  TEST_ORIGIN: string;
  EDGE_SNAPSHOTS: DurableObjectNamespace<EdgeSnapshotDO>;
  NEXT_WALLET: DurableObjectNamespace<NextWalletDO>;
};
const originalFetch = globalThis.fetch;
let origin = "";
const faults = new Map<string, number>();
const lost = new Map<string, number>();
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["example.com", "clerk.invalid", "api.clerk.com"].includes(url.hostname))
    return originalFetch(new URL(url.pathname + url.search, origin), init);
  return originalFetch(input, init).then((response) => {
    const remaining = faults.get(url.pathname) ?? 0;
    if (remaining > 0) {
      faults.set(url.pathname, remaining - 1);
      lost.set(url.pathname, (lost.get(url.pathname) ?? 0) + 1);
      throw new Error("Injected lost acknowledgement");
    }
    return response;
  });
}) as typeof fetch;
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
    origin = env.TEST_ORIGIN;
    const url = new URL(request.url);
    if (url.pathname === "/test/fault") {
      const body = (await request.json()) as { path: string; count: number };
      faults.set(body.path, body.count);
      return Response.json(Object.fromEntries(lost));
    }
    if (url.pathname === "/test/snapshot") {
      const { kind, scope, expire } = (await request.json()) as {
        kind: "org" | "keys" | "route" | "catalogue";
        scope: string;
        expire?: boolean;
      };
      const stub = env.EDGE_SNAPSHOTS.get(
        env.EDGE_SNAPSHOTS.idFromName(
          JSON.stringify([env.NEXT_DEPLOYMENT_ID, kind, scope]),
        ),
      );
      await stub.read(kind, scope);
      if (expire) await stub.expire();
      else await stub.refresh();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/test/wallet") {
      const { orgId, action } = (await request.json()) as {
        orgId: string;
        action: string;
      };
      const stub = env.NEXT_WALLET.get(
        env.NEXT_WALLET.idFromName(
          JSON.stringify([env.NEXT_DEPLOYMENT_ID, orgId]),
        ),
      );
      await stub.wake(orgId);
      if (action === "refresh") await stub.refresh();
      if (action === "expire") await stub.expireHolds();
      return Response.json(await stub.inspect());
    }
    return worker.fetch(request, env, ctx);
  },
};
