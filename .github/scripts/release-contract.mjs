import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;
const INTEGER_RE = /^[1-9]\d*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEDIA_TYPE_RE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*charset=[a-z0-9-]+)?$/i;
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
const DEFAULT_ATTEMPTS = 23;
const DEFAULT_INTERVAL_MS = 2_000;

export function validateRelease(release) {
  if (!SHA_RE.test(release)) {
    throw new Error("release must be a lowercase 40-character git SHA");
  }
  return release;
}

export function validateConvexTarget(expected, actual) {
  const expectedOrigin = validateOrigin(expected, "expected Convex");
  const actualOrigin = validateOrigin(actual, "actual Convex");
  if (actualOrigin !== expectedOrigin) {
    throw new Error("Convex deploy key targets unexpected deployment");
  }
  return actualOrigin;
}

export function validateConvexDryRun(expected, output) {
  if (typeof output !== "string" || !output.includes("[dry run]")) {
    throw new Error("Convex target proof requires dry-run output");
  }
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const targets = [
    ...clean.matchAll(
      /└─\s+(https:\/\/[a-z0-9-]+\.convex\.cloud)|Deploying to\s+(https:\/\/[a-z0-9-]+\.convex\.cloud)\.\.\.\s+\[dry run\]/g,
    ),
  ].map((match) => match[1] ?? match[2]);
  if (targets.length === 0) {
    throw new Error("Convex dry-run output did not identify target deployment");
  }
  for (const target of targets) validateConvexTarget(expected, target);
  return validateOrigin(expected, "expected Convex");
}

function validateOrigin(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} origin is required`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `${name} must be an HTTPS origin without path or credentials`,
    );
  }
  return url.origin;
}

function validateProbePath(value, prefix, name) {
  if (
    typeof value !== "string" ||
    !value.startsWith(`/${prefix}/`) ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("//")
  ) {
    throw new Error(`${name} must be an absolute /${prefix}/... path`);
  }
  return value;
}

function validateMethod(value, name) {
  const method = typeof value === "string" ? value.toUpperCase() : "";
  if (!HTTP_METHODS.has(method)) {
    throw new Error(`${name} must be a supported HTTP method`);
  }
  return method;
}

function validateRequestBody(method, body, contentType) {
  if (method === "GET" || method === "HEAD") {
    return { body: undefined, contentType: undefined };
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("RELEASE_PROBE_REQUEST_BODY is required for body methods");
  }
  if (typeof contentType !== "string" || !MEDIA_TYPE_RE.test(contentType)) {
    throw new Error(
      "RELEASE_PROBE_CONTENT_TYPE must be a valid media type for body methods",
    );
  }
  const baseType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (baseType === "application/json" || baseType.endsWith("+json")) {
    try {
      JSON.parse(body);
    } catch {
      throw new Error(
        "RELEASE_PROBE_REQUEST_BODY must be valid JSON for JSON media types",
      );
    }
  }
  return { body, contentType };
}

function targetFromPath(path, prefix) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== prefix || !parts[1] || !parts[2]) {
    throw new Error(`invalid /${prefix}/ probe path`);
  }
  const publisherHandle = decodeURIComponent(parts[1]);
  const slug = decodeURIComponent(parts[2]);
  if (
    publisherHandle.length > 64 ||
    slug.length > 64 ||
    !SLUG_RE.test(publisherHandle) ||
    !SLUG_RE.test(slug)
  ) {
    throw new Error(`/${prefix}/ probe target must use canonical slugs`);
  }
  return {
    publisherHandle,
    slug,
    endpoint: parts.length > 3 ? `/${parts.slice(3).join("/")}` : "/",
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function webRelease(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\bname=["']zevium-release["']/i.test(tag)) continue;
    return tag.match(/\bcontent=(["'])(.*?)\1/i)?.[2] ?? null;
  }
  return null;
}

export function validateProbeOptions(options) {
  const legacyIdentity = options.legacyIdentity === true;
  const gatewayOnly = options.gatewayOnly === true;
  const release = legacyIdentity ? "legacy" : validateRelease(options.release);
  const web = gatewayOnly ? null : validateOrigin(options.web, "web");
  const gateway = validateOrigin(options.gateway, "gateway");
  const overrideName = options.gatewayOverrideName;
  const overrideVersion = options.gatewayOverrideVersion;
  if ((overrideName === undefined) !== (overrideVersion === undefined)) {
    throw new Error(
      "gateway override name and version must be provided together",
    );
  }
  let gatewayOverride = null;
  if (overrideName !== undefined && overrideVersion !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(overrideName)) {
      throw new Error("gateway override name is invalid");
    }
    if (!/^[0-9a-f-]{16,}$/.test(overrideVersion)) {
      throw new Error("gateway override version is invalid");
    }
    gatewayOverride = `${overrideName}="${overrideVersion}"`;
  }

  if (options.identityOnly) {
    return {
      release,
      web,
      gateway,
      legacyIdentity,
      gatewayOnly,
      gatewayOverride,
      identityOnly: true,
    };
  }

  const mockPath = validateProbePath(options.mockPath, "mock", "mockPath");
  const meteredPath = validateProbePath(
    options.meteredPath,
    "gateway",
    "meteredPath",
  );
  const mockMethod = validateMethod(options.mockMethod, "mockMethod");
  const meteredMethod = validateMethod(options.meteredMethod, "meteredMethod");
  if (
    typeof options.apiKey !== "string" ||
    options.apiKey.trim().length === 0
  ) {
    throw new Error("RELEASE_PROBE_API_KEY is required");
  }
  const target = targetFromPath(meteredPath, "gateway");
  const mockTarget = targetFromPath(mockPath, "mock");
  assert(
    mockTarget.publisherHandle === target.publisherHandle &&
      mockTarget.slug === target.slug &&
      mockTarget.endpoint === target.endpoint,
    "mock and metered probes must target same published operation",
  );
  assert(
    mockMethod === meteredMethod,
    "mock and metered probes must use same HTTP method",
  );
  const request = validateRequestBody(
    meteredMethod,
    options.requestBody,
    options.contentType,
  );

  return {
    release,
    web,
    gateway,
    legacyIdentity,
    gatewayOnly,
    gatewayOverride,
    identityOnly: false,
    mockPath,
    meteredPath,
    mockMethod,
    meteredMethod,
    target,
    requestBody: request.body,
    requestContentType: request.contentType,
    apiKey: options.apiKey,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "release contract failed";
}

async function request(fetchImpl, url, init = {}, timeoutMs = 15_000) {
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    redirect: "error",
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, durationMs: Date.now() - startedAt };
}

async function waitForReady({
  fetchImpl,
  url,
  inspect,
  attempts,
  intervalMs,
  sleep,
  name,
  init = {},
}) {
  const startedAt = Date.now();
  let lastStatus = null;
  let lastFailure = "request failed";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const requestUrl = typeof url === "function" ? url(attempt) : url;
      const result = await request(fetchImpl, requestUrl, init, 2_000);
      lastStatus = result.response.status;
      const inspected = await inspect(result.response);
      if (inspected.ready) {
        return {
          ...inspected,
          status: result.response.status,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
      }
      lastFailure = inspected.reason;
    } catch (error) {
      lastFailure = errorMessage(error);
    }

    if (attempt < attempts) await sleep(intervalMs);
  }

  const error = new Error(`${name} did not become ready: ${lastFailure}`);
  error.probeDetails = {
    status: lastStatus,
    attempts,
    durationMs: Date.now() - startedAt,
  };
  throw error;
}

export async function resolveCurrentRelease(options, fetchImpl = fetch) {
  const web = validateOrigin(options.web, "web");
  const gateway = validateOrigin(options.gateway, "gateway");
  const attempts = options.readinessAttempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = options.readinessIntervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep =
    options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("readinessAttempts must be a positive integer");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error("readinessIntervalMs must be a non-negative integer");
  }

  let lastFailure = "identity request failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [landing, health] = await Promise.all([
        request(
          fetchImpl,
          `${web}/?release_probe=current-${attempt}`,
          { headers: { "cache-control": "no-cache" } },
          2_000,
        ),
        request(
          fetchImpl,
          `${gateway}/health`,
          { headers: { "cache-control": "no-cache" } },
          2_000,
        ),
      ]);
      const html = await landing.response.text();
      const body = await health.response.json();
      const webIdentity = webRelease(html);
      const gatewayIdentity = body?.release;
      const documentsReady =
        landing.response.status === 200 &&
        landing.response.headers.get("content-type")?.includes("text/html") &&
        /<title>[^<]*Zevium[^<]*<\/title>/.test(html) &&
        health.response.status === 200 &&
        body?.ok === true &&
        body?.service === "zevium-gateway";
      if (!documentsReady) {
        lastFailure = "web or gateway base contract mismatch";
      } else if (
        SHA_RE.test(webIdentity ?? "") &&
        webIdentity === gatewayIdentity &&
        body?.contract === 1
      ) {
        return webIdentity;
      } else if (
        (webIdentity === null || webIdentity === "development") &&
        (gatewayIdentity === undefined || gatewayIdentity === "development") &&
        (body?.contract === undefined || body?.contract === 1)
      ) {
        return "legacy";
      } else {
        lastFailure = "web and gateway release identities disagree";
      }
    } catch (error) {
      lastFailure = errorMessage(error);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`current production release unresolved: ${lastFailure}`);
}

function bodyInit(method, body, contentType) {
  if (body === undefined || method === "GET" || method === "HEAD") {
    return { method };
  }
  return {
    method,
    headers: { "content-type": contentType },
    body,
  };
}

/**
 * Cross-service contract probe. Evidence contains status, timing, and release
 * identity only. Response bodies and credentials never reach disk.
 */
export async function probeRelease(options, fetchImpl = fetch) {
  const evidence = {
    release:
      typeof options.release === "string" ? options.release : "invalid-release",
    checkedAt: new Date().toISOString(),
    outcome: "running",
    checks: [],
  };
  const attempts = options.readinessAttempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = options.readinessIntervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep =
    options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("readinessAttempts must be a positive integer");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error("readinessIntervalMs must be a non-negative integer");
  }

  const record = (name, result, extra = {}) => {
    evidence.checks.push({
      name,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
      ...extra,
    });
  };

  const runCheck = async (name, callback) => {
    try {
      return await callback();
    } catch (error) {
      const details = error?.probeDetails ?? {};
      evidence.checks.push({ name, outcome: "failed", ...details });
      throw error;
    }
  };

  try {
    const normalized = validateProbeOptions(options);
    const {
      release,
      web,
      gateway,
      legacyIdentity,
      gatewayOnly,
      gatewayOverride,
      identityOnly,
      mockPath,
      meteredPath,
      mockMethod,
      meteredMethod,
      target,
      requestBody,
      requestContentType,
      apiKey,
    } = normalized;
    evidence.release = release;

    const gatewayInit = (init = {}) => {
      if (gatewayOverride === null) return init;
      const headers = new Headers(init.headers);
      headers.set("Cloudflare-Workers-Version-Overrides", gatewayOverride);
      return { ...init, headers };
    };

    if (!gatewayOnly) {
      const landing = await runCheck("web-release-readiness", () =>
        waitForReady({
          fetchImpl,
          url: (attempt) =>
            `${web}/?release_probe=${encodeURIComponent(release)}-${attempt}`,
          attempts,
          intervalMs,
          sleep,
          name: "web release",
          inspect: async (response) => {
            const html = await response.text();
            const identity = webRelease(html);
            return {
              ready:
                response.status === 200 &&
                response.headers.get("content-type")?.includes("text/html") ===
                  true &&
                (legacyIdentity
                  ? identity === null || identity === "development"
                  : identity === release) &&
                /<title>[^<]*Zevium[^<]*<\/title>/.test(html),
              reason:
                response.status !== 200
                  ? `HTTP ${response.status}`
                  : "release metadata or document contract mismatch",
            };
          },
        }),
      );
      record("web-release-readiness", landing);
    }

    const health = await runCheck("gateway-release-readiness", () =>
      waitForReady({
        fetchImpl,
        url: `${gateway}/health`,
        attempts,
        intervalMs,
        sleep,
        name: "gateway release",
        init: gatewayInit({ headers: { "cache-control": "no-cache" } }),
        inspect: async (response) => {
          let body;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          const ready =
            response.status === 200 &&
            body?.ok === true &&
            body?.service === "zevium-gateway" &&
            (legacyIdentity
              ? (body?.release === undefined ||
                  body?.release === "development") &&
                (body?.contract === undefined || body?.contract === 1)
              : body?.release === release && body?.contract === 1);
          return {
            ready,
            reason:
              response.status !== 200
                ? `HTTP ${response.status}`
                : "gateway release identity or contract mismatch",
          };
        },
      }),
    );
    record("gateway-release-readiness", health);

    if (identityOnly) {
      evidence.outcome = "passed";
      return evidence;
    }

    if (!gatewayOnly) {
      const catalogue = await runCheck("web-catalogue-ssr", async () => {
        const result = await request(
          fetchImpl,
          `${web}/catalogue?q=${encodeURIComponent(target.slug)}&sort=newest&release_probe=${encodeURIComponent(release)}`,
        );
        const html = await result.response.text();
        assert(
          result.response.status === 200,
          "catalogue SSR returned non-200",
        );
        assert(
          result.response.headers.get("content-type")?.includes("text/html"),
          "catalogue SSR content type mismatch",
        );
        assert(
          html.includes("<title>Catalogue · Zevium</title>"),
          "catalogue SSR title missing",
        );
        assert(
          html.includes("Public APIs with per-call credits") &&
            html.includes(
              `/catalogue/${target.publisherHandle}/${target.slug}`,
            ) &&
            !html.includes("Something went wrong"),
          "catalogue SSR target listing missing or errored",
        );
        return {
          status: result.response.status,
          durationMs: result.durationMs,
        };
      });
      record("web-catalogue-ssr", catalogue);
    }

    let declaredCost;
    const discovery = await runCheck("control-data-contract", async () => {
      const result = await request(
        fetchImpl,
        `${gateway}/discovery?release_probe=${encodeURIComponent(release)}`,
        gatewayInit({ headers: { "cache-control": "no-cache" } }),
      );
      assert(result.response.status === 200, "discovery returned non-200");
      assert(
        result.response.headers
          .get("content-type")
          ?.includes("application/json"),
        "discovery content type mismatch",
      );
      const index = await result.response.json();
      assert(Array.isArray(index.apis), "discovery contract lacks apis array");
      const listing = index.apis.find(
        (api) =>
          api?.publisherHandle === target.publisherHandle &&
          api?.slug === target.slug,
      );
      assert(listing, "release probe listing missing from discovery");
      assert(
        Array.isArray(listing.endpoints),
        "release probe endpoints missing",
      );
      const operation = listing.endpoints.find(
        (endpoint) =>
          endpoint?.method === meteredMethod &&
          endpoint?.path === target.endpoint,
      );
      assert(operation, "release probe operation missing from discovery");
      assert(
        Number.isInteger(operation.credits) && operation.credits > 0,
        "release probe discovery price must be positive",
      );
      declaredCost = operation.credits;
      return { status: result.response.status, durationMs: result.durationMs };
    });
    record("control-data-contract", discovery);

    const cors = await runCheck("gateway-cors-contract", async () => {
      const result = await request(
        fetchImpl,
        `${gateway}${meteredPath}`,
        gatewayInit({
          method: "OPTIONS",
          headers: {
            origin: "https://release-probe.invalid",
            "access-control-request-method": meteredMethod,
            "access-control-request-headers": "authorization, content-type",
          },
        }),
      );
      assert(
        result.response.status === 204,
        "gateway CORS preflight contract failed",
      );
      assert(
        result.response.headers.get("access-control-allow-origin") === "*",
        "gateway CORS origin mismatch",
      );
      const allowedHeaders = new Set(
        (result.response.headers.get("access-control-allow-headers") ?? "")
          .toLowerCase()
          .split(",")
          .map((header) => header.trim()),
      );
      assert(
        allowedHeaders.has("authorization"),
        "gateway CORS auth header missing",
      );
      assert(
        allowedHeaders.has("content-type"),
        "gateway CORS content-type header missing",
      );
      const allowedMethods = new Set(
        (result.response.headers.get("access-control-allow-methods") ?? "")
          .toUpperCase()
          .split(",")
          .map((method) => method.trim()),
      );
      assert(allowedMethods.has(meteredMethod), "gateway CORS method missing");
      return { status: result.response.status, durationMs: result.durationMs };
    });
    record("gateway-cors-contract", cors);

    const mock = await runCheck("published-spec-mock", async () => {
      const result = await request(
        fetchImpl,
        `${gateway}${mockPath}`,
        gatewayInit(bodyInit(mockMethod, requestBody, requestContentType)),
      );
      assert(
        result.response.status === 200,
        "published spec mock deep probe failed",
      );
      assert(
        result.response.headers.get("x-zevium-mock") === "1",
        "mock marker missing",
      );
      assert(
        result.response.headers.get("x-zevium-cost") === "0",
        "mock charged credits",
      );
      assert(
        Boolean(result.response.headers.get("x-zevium-request-id")),
        "mock request id missing",
      );
      await result.response.body?.cancel();
      return { status: result.response.status, durationMs: result.durationMs };
    });
    record("published-spec-mock", mock);

    const metered = await runCheck("metered-wallet-upstream", async () => {
      const init = bodyInit(meteredMethod, requestBody, requestContentType);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${apiKey}`);
      const result = await request(fetchImpl, `${gateway}${meteredPath}`, {
        ...gatewayInit({ ...init, headers }),
      });
      assert(
        result.response.status >= 200 && result.response.status < 300,
        "metered gateway deep probe failed",
      );
      const cost = result.response.headers.get("x-zevium-cost") ?? "";
      assert(
        INTEGER_RE.test(cost),
        "metered response cost must be positive integer",
      );
      assert(
        Number(cost) === declaredCost,
        "metered response cost differs from published discovery price",
      );
      assert(
        Boolean(result.response.headers.get("x-zevium-request-id")),
        "metered response request id missing",
      );
      await result.response.body?.cancel();
      return {
        status: result.response.status,
        durationMs: result.durationMs,
        cost: Number(cost),
      };
    });
    record("metered-wallet-upstream", metered, { cost: metered.cost });

    evidence.outcome = "passed";
    return evidence;
  } catch (error) {
    evidence.outcome = "failed";
    evidence.failure = errorMessage(error);
    const wrapped =
      error instanceof Error ? error : new Error(errorMessage(error));
    wrapped.evidence = evidence;
    throw wrapped;
  }
}

function parseArgs(argv) {
  const entries = argv.map((arg) => {
    if (!arg.startsWith("--") || !arg.includes("=")) {
      throw new Error(`invalid argument: ${arg}`);
    }
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  });
  return Object.fromEntries(entries);
}

async function writeEvidence(output, evidence) {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    release: args.release,
    web: args.web,
    gateway: args.gateway,
    identityOnly: args["identity-only"] === "true",
    legacyIdentity: args.legacy === "true",
    gatewayOnly: args["gateway-only"] === "true",
    gatewayOverrideName: args["gateway-override-name"],
    gatewayOverrideVersion: args["gateway-override-version"],
    mockPath: args["mock-path"],
    mockMethod: args["mock-method"],
    meteredPath: args["metered-path"],
    meteredMethod: args["metered-method"],
    contentType: args["content-type"],
    requestBody: process.env.RELEASE_PROBE_REQUEST_BODY || undefined,
    apiKey: process.env.RELEASE_PROBE_API_KEY,
  };
  if (args["current-release"] === "true") {
    process.stdout.write(await resolveCurrentRelease(options));
    return;
  }
  if (args["validate-convex-dry-run"] === "true") {
    let output = "";
    for await (const chunk of process.stdin) output += chunk;
    validateConvexDryRun(process.env.EXPECTED_CONVEX_URL, output);
    return;
  }
  if (args["validate-only"] === "true") {
    validateProbeOptions(options);
    return;
  }
  const output = args.output ?? "release-evidence/contract.json";
  try {
    const evidence = await probeRelease(options);
    await writeEvidence(output, evidence);
  } catch (error) {
    const evidence = error?.evidence ?? {
      checkedAt: new Date().toISOString(),
      outcome: "failed",
      failure: errorMessage(error),
      checks: [],
    };
    await writeEvidence(output, evidence);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
