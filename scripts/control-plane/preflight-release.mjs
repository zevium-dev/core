import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Read-only gate, before any environment write or code deployment. */
export async function preflightRelease({
  gatewayUrl,
  deploymentId,
  readMarker,
  fetchHealth = fetch,
}) {
  if (!deploymentId?.trim()) throw new Error("NEXT_DEPLOYMENT_ID is required");
  const url = new URL(gatewayUrl);
  if (url.protocol !== "https:" || url.origin !== gatewayUrl)
    throw new Error("NEXT_GATEWAY_URL must be an HTTPS origin");
  const response = await fetchHealth(`${gatewayUrl}/health`, {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error("Gateway health unavailable; manual cutover required");
  const health = await response.json();
  if (
    health?.contract !== 2 ||
    health.ok !== true ||
    health.service !== "zevium-gateway"
  )
    throw new Error(
      "Gateway contract 2 required; complete manual Worker cutover first",
    );
  const marker = readMarker();
  // Convex env get exits 0 with empty stdout when the variable is absent.
  // Authentication/transport failures are never treated as an absent marker.
  if (marker.status !== 0)
    throw new Error("Cannot verify Convex deployment marker");
  // Strip only the CLI line ending, never whitespace belonging to the ID.
  const existing = marker.stdout.replace(/\r?\n$/, "");
  if (marker.stdout !== "" && existing !== deploymentId)
    throw new Error(
      "Convex NEXT_DEPLOYMENT_ID mismatch; refusing paired runtime changes",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await preflightRelease({
      gatewayUrl: process.env.NEXT_GATEWAY_URL,
      deploymentId: process.env.NEXT_DEPLOYMENT_ID,
      readMarker: () =>
        spawnSync(
          "pnpm",
          [
            "exec",
            "convex",
            "env",
            "get",
            "NEXT_DEPLOYMENT_ID",
            ...process.argv.slice(2),
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          },
        ),
    });
    console.log("Paired release cutover preflight passed.");
  } catch {
    console.error(
      "Release blocked: require healthy gateway contract 2 and unset-or-matching Convex NEXT_DEPLOYMENT_ID. See .agents/notes/architecture/convex-activation.md.",
    );
    process.exitCode = 1;
  }
}
