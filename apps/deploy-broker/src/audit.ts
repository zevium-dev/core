import type { ApiRouteKind } from "./api-policy";
import type { DeploymentManifest } from "./manifest";

export interface AuditEvent {
  code?: string;
  decision: "allow" | "deny";
  method: string;
  route?: ApiRouteKind | "manifest" | "manifest-dry-run";
  sessionId?: string;
  status: number;
  target?: string;
}

export function audit(event: AuditEvent, manifest?: DeploymentManifest): void {
  console.log(
    JSON.stringify({
      actor: manifest ? "github-actions" : undefined,
      code: event.code,
      decision: event.decision,
      environment: manifest?.environment,
      event: "cloudflare_deploy_audit",
      headSha: manifest?.headSha,
      method: event.method,
      profile: manifest?.profile,
      route: event.route,
      runAttempt: manifest?.runAttempt,
      runId: manifest?.runId,
      sessionId: event.sessionId?.slice(0, 16),
      status: event.status,
      target: event.target,
    }),
  );
}
