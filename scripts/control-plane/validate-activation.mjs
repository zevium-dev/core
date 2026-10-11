import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateActivation(config) {
  const errors = [];
  const { convex = {}, worker = {}, web = {} } = config;
  const requireValue = (values, scope, name) => {
    if (typeof values[name] !== "string" || !values[name].trim())
      errors.push(`${scope}.${name} is required`);
    return values[name];
  };
  const same = (a, an, b, bn) => {
    if (!a[an] || a[an] !== b[bn])
      errors.push(`${an} must match ${bn} across paired services`);
  };
  const origin = (value, name) => {
    try {
      const url = new URL(value);
      if (url.origin !== value || url.protocol !== "https:") throw new Error();
    } catch {
      errors.push(`${name} must be an HTTPS origin without a path`);
    }
  };
  for (const name of [
    "NEXT_DEPLOYMENT_ID",
    "NEXT_SNAPSHOT_KEYS",
    "NEXT_ADMISSION_KEYS",
    "NEXT_TRANSPORT_KEYS",
    "GATEWAY_INTERNAL_SECRET",
  ]) {
    requireValue(convex, "convex", name);
    requireValue(worker, "worker", name);
    same(convex, name, worker, name);
  }
  for (const name of [
    "CONVEX_URL",
    "CONVEX_SITE_URL",
    "NEXT_GATEWAY_URL",
    "NEXT_APP_ORIGIN",
    "APP_ORIGIN",
    "CLERK_JWT_ISSUER_DOMAIN",
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "REGISTRY_KEY_PROJECTION_HMAC_SECRET",
    "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
    "ADMIN_USER_IDS",
    "NEXT_STRIPE_SECRET_KEY",
    "NEXT_STRIPE_PLATFORM_ACCOUNT_ID",
    "NEXT_STRIPE_WEBHOOK_SECRET",
    "NEXT_STRIPE_CONNECT_WEBHOOK_SECRET",
    "NEXT_STRIPE_V2_WEBHOOK_SECRET",
    "NEXT_STRIPE_PRICE_PACK_10",
    "NEXT_STRIPE_PRICE_PACK_50",
    "NEXT_STRIPE_PRICE_PACK_100",
  ])
    requireValue(convex, "convex", name);
  for (const name of [
    "VITE_CONVEX_URL",
    "VITE_GATEWAY_URL",
    "CONVEX_SITE_URL",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "REGISTRY_KEY_PROJECTION_HMAC_SECRET",
  ])
    requireValue(web, "web", name);
  for (const name of ["CONVEX_SITE_URL", "APP_ORIGIN"])
    requireValue(worker, "worker", name);
  for (const [a, an, b, bn] of [
    [convex, "CONVEX_URL", web, "VITE_CONVEX_URL"],
    [convex, "CONVEX_SITE_URL", worker, "CONVEX_SITE_URL"],
    [convex, "CONVEX_SITE_URL", web, "CONVEX_SITE_URL"],
    [convex, "NEXT_GATEWAY_URL", web, "VITE_GATEWAY_URL"],
    [convex, "NEXT_APP_ORIGIN", convex, "APP_ORIGIN"],
    [convex, "APP_ORIGIN", worker, "APP_ORIGIN"],
    [convex, "CLERK_SECRET_KEY", web, "CLERK_SECRET_KEY"],
    [
      convex,
      "REGISTRY_KEY_PROJECTION_HMAC_SECRET",
      web,
      "REGISTRY_KEY_PROJECTION_HMAC_SECRET",
    ],
  ])
    same(a, an, b, bn);
  for (const name of [
    "CONVEX_URL",
    "CONVEX_SITE_URL",
    "NEXT_GATEWAY_URL",
    "APP_ORIGIN",
    "CLERK_JWT_ISSUER_DOMAIN",
  ])
    origin(convex[name], name);
  if (
    !/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(convex.CONVEX_URL ?? "") ||
    convex.CONVEX_URL?.replace(".convex.cloud", ".convex.site") !==
      convex.CONVEX_SITE_URL
  )
    errors.push("Convex cloud/site destinations must name the same deployment");
  const material = new Set();
  for (const name of [
    "NEXT_SNAPSHOT_KEYS",
    "NEXT_ADMISSION_KEYS",
    "NEXT_TRANSPORT_KEYS",
    "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS",
  ]) {
    try {
      const ring = JSON.parse(convex[name]);
      if (!ring.current || !ring.keys?.[ring.current]) throw new Error();
      for (const [id, value] of Object.entries(ring.keys)) {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
          typeof value !== "string" ||
          value.length < 32
        )
          throw new Error();
        if (
          name === "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS" &&
          (Buffer.from(value, "base64").length !== 32 ||
            Buffer.from(value, "base64").toString("base64") !== value)
        )
          throw new Error();
        if (material.has(value))
          errors.push(
            `${name} reuses key material; keyrings must be independent`,
          );
        material.add(value);
      }
    } catch {
      errors.push(`${name} must contain a valid versioned keyring`);
    }
  }
  for (const name of [
    "GATEWAY_INTERNAL_SECRET",
    "REGISTRY_KEY_PROJECTION_HMAC_SECRET",
    "NEXT_WEB_SEARCH_SECRET",
  ]) {
    const value = convex[name];
    if (name === "NEXT_WEB_SEARCH_SECRET" && !value && !web[name]) continue;
    if (typeof value !== "string" || value.length < 32)
      errors.push(`${name} must contain at least 32 characters`);
    if (material.has(value))
      errors.push(`${name} must use independent material`);
    material.add(value);
  }
  if (convex.NEXT_WEB_SEARCH_SECRET || web.NEXT_WEB_SEARCH_SECRET)
    same(convex, "NEXT_WEB_SEARCH_SECRET", web, "NEXT_WEB_SEARCH_SECRET");
  if (!/^(sk|rk)_test_/.test(convex.NEXT_STRIPE_SECRET_KEY ?? ""))
    errors.push("NEXT_STRIPE_SECRET_KEY must be test-mode");
  if (convex.NEXT_CARD_FEE_ENABLED === "true")
    errors.push("Card surcharge activation remains blocked by #318");
  for (const values of [convex, worker, web]) {
    for (const name of [
      "CONTROL_PLANE_MODE",
      "VITE_CONTROL_PLANE_MODE",
      "VITE_NEXT_CONVEX_URL",
      "NEXT_ADMISSION_SECRET",
      "GATEWAY_REGISTRY_TRANSPORT_KEYRING",
      "GATEWAY_REGISTRY_SYNC_BASE_URL",
      "GATEWAY_REGISTRY_SYNC_HMAC_SECRET",
    ])
      if (values[name]) errors.push(`${name} is retired; remove it`);
    if (values.X402_ENABLED === "true")
      errors.push("x402 must remain disabled");
  }
  if (worker.MCP_OAUTH_ISSUER || worker.MCP_OAUTH_RESOURCE) {
    same(convex, "CLERK_SECRET_KEY", worker, "CLERK_SECRET_KEY");
    same(convex, "CLERK_JWT_ISSUER_DOMAIN", worker, "MCP_OAUTH_ISSUER");
    if (worker.MCP_OAUTH_RESOURCE !== `${convex.NEXT_GATEWAY_URL}/mcp`)
      errors.push("MCP_OAUTH_RESOURCE must be the paired gateway /mcp");
  }
  if (convex.RESEND_API_KEY && !convex.EMAIL_FROM)
    errors.push("EMAIL_FROM is required when Resend is enabled");
  return errors;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const errors = validateActivation(
      JSON.parse(readFileSync(process.argv[2], "utf8")),
    );
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else
      console.log(
        "Activation configuration matches. Provider delivery and browser gates still require owner verification.",
      );
  } catch {
    console.error(
      "Supply a private JSON file containing convex, worker and web environment maps. Values are never printed.",
    );
    process.exitCode = 1;
  }
}
