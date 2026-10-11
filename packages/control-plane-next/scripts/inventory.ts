import ts from "typescript";
import { inventoryDrift } from "./inventory-drift";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifestPath = new URL("../contracts/inventory.json", import.meta.url);
function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() &&
      !["node_modules", "_generated", "dist"].includes(e.name)
        ? files(`${dir}/${e.name}`)
        : e.isFile() &&
            /\.(ts|tsx|mjs)$/.test(e.name) &&
            !/\.(test|spec)\./.test(e.name)
          ? [`${dir}/${e.name}`]
          : [],
    )
    .sort();
}
const appFiles = [...files("apps/web/src"), ...files("apps/gateway/src")];
const sources = [...files("convex"), ...appFiles, ...files("scripts")];
const configPath = path.join(root, "convex/tsconfig.json");
const parsed = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  },
)!;
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const trees = new Map(
  sources.map((file) => [
    file,
    program.getSourceFile(path.join(root, file)) ??
      ts.createSourceFile(
        file,
        readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
  ]),
);
function walk(node: ts.Node, fn: (n: ts.Node) => void) {
  fn(node);
  ts.forEachChild(node, (n) => walk(n, fn));
}
const references = new Map<string, Set<string>>();
for (const [file, tree] of trees) {
  walk(tree, (n) => {
    const match = ts.isPropertyAccessExpression(n)
      ? n.getText(tree).match(/^(api|internal)\.([\w]+)\.([\w]+)$/)
      : null;
    const stringRef =
      ts.isCallExpression(n) &&
      n.expression.getText(tree) === "makeFunctionReference" &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
        ? n.arguments[0].text
        : null;
    const gatewayRef =
      ts.isCallExpression(n) &&
      n.expression.getText(tree) === "queryConvex" &&
      n.arguments[1] &&
      ts.isStringLiteral(n.arguments[1])
        ? n.arguments[1].text
        : null;
    const ref = match ? `${match[2]}:${match[3]}` : (stringRef ?? gatewayRef);
    if (ref) {
      const set = references.get(ref) ?? new Set();
      set.add(file);
      references.set(ref, set);
    }
  });
}
const retiredModules = new Set([
  "machinePayments",
  "deploymentProof",
  "registrySync",
]);
const retiredFunctions = new Set([
  "specImports:acquireLease",
  "quality:setSubscription",
  "quality:listSubscriptions",
  "quality:subscriberCount",
]);
const changedModules = new Set([
  "wallets",
  "billing",
  "payouts",
  "projects",
  "organizations",
  "users",
  "keySettings",
  "publishReadiness",
  "reviews",
  "analytics",
  "earnings",
  "usage",
  "catalogue",
  "search",
  "notifications",
  "notificationEmail",
  "notificationEmailAction",
]);
const historical = Array.from(
  readFileSync(
    path.join(root, ".agents/notes/architecture/convex-rebuild.md"),
    "utf8",
  ).matchAll(/^\| `([\w]+:[\w]+)` \(/gm),
  (m) => m[1],
);
const functions: Array<{
  name: string;
  kind: string;
  source: string;
  status: string;
  reason: string;
  callers: string[];
  appCallers: string[];
  historical: boolean;
  args: string | null;
  returns: string;
  inferredReturn: string;
  fixture: string;
  implementation: string;
}> = [];
for (const [file, tree] of trees) {
  if (!file.startsWith("convex/")) continue;
  for (const statement of tree.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
      const kind = decl.initializer.expression.getText(tree);
      if (
        !/^(query|mutation|action|internalQuery|internalMutation|internalAction)$/.test(
          kind,
        )
      )
        continue;
      const module = file.slice(7, -3);
      const name = `${module}:${decl.name.getText(tree)}`;
      let config = decl.initializer.arguments[0];
      if (ts.isIdentifier(config)) {
        const local = tree.statements
          .filter(ts.isVariableStatement)
          .flatMap((s) => [...s.declarationList.declarations])
          .find((d) => d.name.getText(tree) === config.getText(tree));
        if (local?.initializer) config = local.initializer;
      }
      const property = (key: string) =>
        ts.isObjectLiteralExpression(config)
          ? config.properties.find(
              (p) => ts.isPropertyAssignment(p) && p.name.getText(tree) === key,
            )
          : undefined;
      const args = property("args");
      const returns = property("returns");
      const callers = Array.from(references.get(name) ?? [])
        .filter((p) => p !== file)
        .sort();
      const status =
        retiredModules.has(module) || retiredFunctions.has(name)
          ? "retired"
          : kind.startsWith("internal") || changedModules.has(module)
            ? "changed"
            : "retained";
      const registeredType = checker.getTypeAtLocation(decl.initializer);
      const handlerSymbol = checker.getPropertyOfType(
        registeredType,
        "_handler",
      );
      const signature = handlerSymbol
        ? checker
            .getTypeOfSymbolAtLocation(handlerSymbol, decl.initializer)
            .getCallSignatures()[0]
        : undefined;
      const returnType = signature
        ? checker.getReturnTypeOfSignature(signature)
        : registeredType.aliasTypeArguments?.[2];
      const rawReturn = returnType
        ? checker.typeToString(
            returnType,
            decl,
            ts.TypeFormatFlags.NoTruncation,
          )
        : checker.typeToString(
            registeredType,
            decl,
            ts.TypeFormatFlags.NoTruncation,
          );
      const inferredReturn = rawReturn.replace(
        /import\("([^"]+)"\)/g,
        (_match, modulePath: string) => {
          const marker = "/node_modules/";
          const index = modulePath.lastIndexOf(marker);
          const stable =
            index >= 0
              ? modulePath.slice(index + marker.length)
              : path.isAbsolute(modulePath)
                ? path.relative(root, modulePath)
                : modulePath;
          return `import(${JSON.stringify(stable)})`;
        },
      );
      functions.push({
        name,
        kind,
        source: file,
        status,
        reason:
          status === "retired"
            ? module === "machinePayments"
              ? "x402 deferred; no replacement owner/session/funding variant"
              : module === "registrySync"
                ? "Replace outbox identity proof and route reservation before removal"
                : module === "deploymentProof"
                  ? "Recheck release tooling absence in PR 7"
                  : "Remove with paired caller/lifecycle edits"
            : status === "changed"
              ? kind.startsWith("internal")
                ? "Internal implementation seam; replace storage, preserve accounting/auth facts"
                : "Preserve consumed DTO/authorization; apply documented schema/protocol changes"
              : "Preserve arguments, rendered fields, null/error and authorization semantics",
        callers,
        appCallers: callers.filter((p) => p.startsWith("apps/")),
        historical: historical.includes(name),
        args:
          args && ts.isPropertyAssignment(args)
            ? args.initializer.getText(tree)
            : null,
        returns:
          returns && ts.isPropertyAssignment(returns)
            ? returns.initializer.getText(tree)
            : "inferred; implementation and consumed DTO fixture own return shape",
        inferredReturn,
        fixture: historical.includes(name)
          ? "historical-fixtures.json#" + name
          : "surface-fixtures.json",
        implementation: "pending",
      });
    }
  }
}
functions.sort((a, b) => a.name.localeCompare(b.name));
const http = readFileSync(path.join(root, "convex/http.ts"), "utf8");
const paths = [
  ...new Set([
    ...Array.from(http.matchAll(/path: "([^"]+)"/g), (m) => m[1]),
    ...Array.from(
      http.matchAll(/stripeWebhookRoute\(\s*"([^"]+)"/g),
      (m) => m[1],
    ),
  ]),
].sort();
const routes = paths.map((route) => ({
  route,
  method: ["/wallet-grants", "/gateway-spec"].includes(route) ? "GET" : "POST",
  status:
    route === "/machine-fund" || route === "/release-probe-accounting"
      ? "retired"
      : route === "/resend-webhook"
        ? "changed"
        : "retained",
  reason:
    route === "/machine-fund"
      ? "x402 settlement deferred"
      : route === "/release-probe-accounting"
        ? "No release caller remains; remove in PR 7 after recheck"
        : route === "/resend-webhook"
          ? "Current Resend delivery callback; PR 6 must resolve component-backed email parity within table budget"
          : "Preserve route envelope; v2 ingest/wallet authority and shared secret validation change in PR 5",
  callers: appFiles.filter((file) => trees.get(file)!.text.includes(route)),
  fixture: "surface-fixtures.json",
}));
const missingHistorical = historical.filter(
  (name) => !functions.some((f) => f.name === name),
);
const missingReferences = Array.from(references)
  .filter(([name]) => !functions.some((f) => f.name === name))
  .map(([name, callers]) => ({ name, callers: [...callers].sort() }));
const result = {
  baseline: "84f12c45",
  method:
    "TypeScript AST registered exports and api/internal/makeFunctionReference/queryConvex callers; non-test source only. HTTP literal paths plus Stripe registration helper. Internal seams are changed, not promised public compatibility.",
  counts: {
    registeredFunctions: functions.length,
    appCalledFunctions: functions.filter((f) => f.appCallers.length).length,
    historicalFunctions: historical.length,
    httpRoutes: routes.length,
  },
  deferred: [
    {
      feature: "LLM per-token",
      status: "retired",
      fields: [
        "token_usage",
        "tokenPricing",
        "tokenUsage",
        "inputTokens",
        "outputTokens",
      ],
      reason:
        "No scalar fallback; PR 5/6 pair disabled execution and discovery",
    },
    {
      feature: "capability routing",
      status: "retired",
      fields: [
        "capabilityProviders",
        "membership",
        "attempts",
        "normalization",
      ],
      reason:
        "Design only; no current registered module. One listing has one upstream",
    },
    {
      feature: "x402",
      status: "retired",
      fields: [
        "walletSessions",
        "anonymous owner",
        "machinePayments:fund",
        "/machine-fund",
      ],
      reason:
        "Omit settlement/session variants; preserve API-key recovery and keyless mock",
    },
    {
      feature: "admin-key ingest fallback",
      status: "retired",
      fields: ["gateway direct wallets:recordUsage"],
      reason:
        "Internal function remains behind HTTP; never restore gateway admin-key invocation",
    },
  ],
  missingHistorical,
  missingReferences,
  functions,
  routes,
};
const text = JSON.stringify(result, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(manifestPath, text);
else {
  const frozen = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as typeof result;
  const drift = inventoryDrift(frozen, result);
  if (drift.blocking)
    throw new Error(
      "Contract classification drift (function names/kinds/status or HTTP routes): run contracts:refresh and review classifications",
    );
  if (drift.advisory)
    console.warn(
      "Advisory inventory drift: arguments, returns, callers or metadata changed; contracts:refresh is optional. Classifications passed.",
    );
}
console.log(result.counts);
