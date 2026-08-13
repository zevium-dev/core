import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";

export const scriptExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export const structuredDataExtensions = new Set([
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
]);

// Every exclusion is repository-relative and names one concrete generated,
// vendored, or ephemeral root. Basename-wide exclusions (for example every
// directory named `dist`) are forbidden: source directories may use those
// names and still belong to quality gates.
export const repositoryExclusions = Object.freeze([
  { path: ".git", provenance: "Git administrative data" },
  { path: ".claude", provenance: "agent-skill compatibility alias" },
  { path: ".agents", provenance: "vendored agent skill assets" },
  { path: ".project", provenance: "local project orchestration metadata" },
  { path: ".cache", provenance: "tool cache" },
  { path: ".vercel", provenance: "Vercel generated state" },
  { path: ".output", provenance: "framework build output" },
  { path: ".nitro", provenance: "Nitro build state" },
  { path: ".turbo", provenance: "Turborepo cache" },
  { path: "api", provenance: "root adapter build output" },
  { path: "build", provenance: "root build output" },
  { path: "dist", provenance: "root distribution output" },
  { path: "node_modules", provenance: "pnpm dependency tree" },
  { path: "public/build", provenance: "root public build output" },
  { path: "server/build", provenance: "root server build output" },
  { path: "test-results", provenance: "browser-test output" },
  { path: "playwright-report", provenance: "browser-test report" },
  { path: "blob-report", provenance: "browser-test report" },
  { path: "playwright/.cache", provenance: "browser-test cache" },
  { path: "e2e/artifacts", provenance: "browser-test artifacts" },
  { path: "apps/gateway/.turbo", provenance: "Turborepo cache" },
  { path: "apps/gateway/.wrangler", provenance: "Wrangler state" },
  { path: "apps/gateway/dist", provenance: "gateway build output" },
  {
    path: "apps/deploy-broker/node_modules",
    provenance: "pnpm dependency tree",
  },
  { path: "apps/gateway/node_modules", provenance: "pnpm dependency tree" },
  { path: "apps/web/.nitro", provenance: "Nitro build state" },
  { path: "apps/web/.output", provenance: "Nitro build output" },
  { path: "apps/web/.tanstack", provenance: "TanStack generated state" },
  { path: "apps/web/.turbo", provenance: "Turborepo cache" },
  { path: "apps/web/.vinxi", provenance: "Vinxi generated state" },
  { path: "apps/web/.wrangler", provenance: "Wrangler state" },
  { path: "apps/web/dist", provenance: "web build output" },
  { path: "apps/web/dist-ssr", provenance: "web SSR build output" },
  { path: "apps/web/node_modules", provenance: "pnpm dependency tree" },
  {
    path: "apps/web/scripts/csrf-runtime-runner.mjs",
    provenance:
      "runtime CSRF proof runner imports the built worker via a computed file URL",
  },
  {
    path: "apps/web/src/routeTree.gen.ts",
    provenance: "route generator output checked by routes:check",
    importable: true,
  },
  {
    path: "convex/_generated",
    provenance: "Convex generator output checked by routes:check",
    importable: true,
  },
  { path: "convex/node_modules", provenance: "pnpm dependency tree" },
  { path: "packages/shared/.turbo", provenance: "Turborepo cache" },
  { path: "packages/shared/dist", provenance: "shared-package build output" },
  { path: "packages/shared/node_modules", provenance: "pnpm dependency tree" },
  {
    path: "scripts/quality/fixtures",
    provenance: "deliberately hostile quality-gate fixtures",
    fixture: true,
  },
]);

function normalize(path) {
  return path.split(sep).join("/");
}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function applicableExclusions(repository, excludeFixtures) {
  return repositoryExclusions
    .filter((entry) => excludeFixtures || !entry.fixture)
    .map((entry) => ({ ...entry, absolute: resolve(repository, entry.path) }));
}

export function exclusionForPath(
  path,
  repository,
  { excludeFixtures = true } = {},
) {
  const absolute = resolve(path);
  return applicableExclusions(resolve(repository), excludeFixtures).find(
    (entry) => isWithin(absolute, entry.absolute),
  );
}

function assertRootContained(root, repository) {
  const repositoryPath = resolve(repository);
  const rootPath = resolve(root);
  if (!isWithin(rootPath, repositoryPath) && rootPath !== repositoryPath) {
    // Explicit fixture roots outside this repository are supported. They get
    // no repository exclusions, so a nested directory called `dist` is still
    // scanned.
    return false;
  }
  return true;
}

export function collectOwnedFiles({
  roots,
  repository,
  extensions,
  excludeFixtures = true,
  excludedRoots = [],
}) {
  const repositoryPath = resolve(repository);
  const extensionSet =
    extensions instanceof Set ? extensions : new Set(extensions);
  const callerExclusions = excludedRoots.map((path) => resolve(path));
  const files = new Set();

  function visit(path, useRepositoryPolicy) {
    const explicitExclusion = callerExclusions.find((root) =>
      isWithin(path, root),
    );
    if (explicitExclusion) return;
    if (
      useRepositoryPolicy &&
      exclusionForPath(path, repositoryPath, { excludeFixtures })
    )
      return;

    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Cannot enumerate owned path ${normalize(relative(repositoryPath, path))}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (
        callerExclusions.some((root) => isWithin(child, root)) ||
        (useRepositoryPolicy &&
          exclusionForPath(child, repositoryPath, { excludeFixtures }))
      )
        continue;
      if (entry.isSymbolicLink()) {
        if (
          statSync(child).isDirectory() ||
          extensionSet.has(extname(entry.name))
        ) {
          throw new Error(
            `Owned inventory must not contain a source symlink: ${normalize(relative(repositoryPath, child))}`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(child, useRepositoryPolicy);
      } else if (entry.isFile() && extensionSet.has(extname(entry.name))) {
        files.add(child);
      }
    }
  }

  for (const root of roots.map((path) => resolve(path))) {
    visit(root, assertRootContained(root, repositoryPath));
  }
  return [...files].sort();
}

function scriptKind(path) {
  switch (extname(path)) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

export function parseScript(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error(
      `${path}: ${source.parseDiagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("; ")}`,
    );
  }
  return source;
}

function staticString(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts.isTemplateExpression(current)) {
    let result = current.head.text;
    for (const span of current.templateSpans) {
      const value = staticString(span.expression);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(current.left);
    const right = staticString(current.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function moduleReferences(source) {
  const references = [];

  function add(node, expression, dynamic = false) {
    const specifier = staticString(expression);
    if (specifier === undefined) {
      if (dynamic) references.push({ node, specifier: undefined, dynamic });
      return;
    }
    references.push({ node, specifier, dynamic });
  }

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      add(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      add(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      add(node, node.arguments[0], true);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return references;
}

function resolveFileTarget(base) {
  const candidates = [
    base,
    ...[...scriptExtensions].map((extension) => `${base}${extension}`),
    ...[...scriptExtensions].map((extension) =>
      join(base, `index${extension}`),
    ),
  ];
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT"))
        throw error;
    }
  }
  return resolve(base);
}

function repositoryProjectRoots(repository) {
  const roots = [resolve(repository)];
  for (const parent of ["apps", "packages"]) {
    let entries;
    try {
      entries = readdirSync(resolve(repository, parent), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT")
        continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      roots.push(resolve(repository, parent, entry.name));
    }
  }
  const convex = resolve(repository, "convex");
  if (existsSync(convex)) roots.push(convex);
  return roots;
}

function workspacePackages(projectRoots, repository) {
  const packages = [];
  for (const root of projectRoots) {
    const manifestPath = resolve(root, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT")
        continue;
      throw new Error(
        `${normalize(relative(repository, manifestPath))}: invalid workspace manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof manifest.name === "string")
      packages.push({ name: manifest.name, root, manifest });
  }
  return packages.sort((left, right) => right.name.length - left.name.length);
}

function exportTargets(value, wildcard = "") {
  if (typeof value === "string") return [value.replaceAll("*", wildcard)];
  if (Array.isArray(value))
    return value.flatMap((target) => exportTargets(target, wildcard));
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((target) =>
    exportTargets(target, wildcard),
  );
}

function mappedTargets(map, key) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  if (Object.hasOwn(map, key)) return exportTargets(map[key]);
  const wildcardMatches = Object.entries(map)
    .filter(([pattern]) => pattern.includes("*"))
    .map(([pattern, target]) => {
      const [prefix, suffix] = pattern.split("*");
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
      const wildcard = key.slice(prefix.length, key.length - suffix.length);
      return { pattern, target, wildcard };
    })
    .filter(Boolean)
    .sort((left, right) => right.pattern.length - left.pattern.length);
  const match = wildcardMatches[0];
  return match ? exportTargets(match.target, match.wildcard) : [];
}

function workspaceImportBases(specifier, packages) {
  const workspace = packages.find(
    ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
  );
  if (!workspace) return [];
  const subpath =
    specifier === workspace.name
      ? "."
      : `./${specifier.slice(workspace.name.length + 1)}`;
  const exports = workspace.manifest.exports;
  let targets = [];
  if (typeof exports === "string" && subpath === ".") {
    targets = [exports];
  } else if (
    exports &&
    typeof exports === "object" &&
    !Array.isArray(exports)
  ) {
    const hasSubpathKeys = Object.keys(exports).some((key) =>
      key.startsWith("."),
    );
    targets = hasSubpathKeys
      ? mappedTargets(exports, subpath)
      : subpath === "."
        ? exportTargets(exports)
        : [];
  }
  if (targets.length === 0) {
    const fallback =
      subpath === "."
        ? (workspace.manifest.module ??
          workspace.manifest.main ??
          workspace.manifest.types ??
          ".")
        : subpath;
    targets = typeof fallback === "string" ? [fallback] : [subpath];
  }
  return targets
    .filter((target) => target.startsWith("."))
    .map((target) => resolve(workspace.root, target));
}

function compilerPathMappings(projectRoots) {
  const mappings = [];
  for (const root of projectRoots) {
    const configPath = resolve(root, "tsconfig.json");
    if (!existsSync(configPath)) continue;
    let fatal;
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          fatal = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        },
      },
    );
    if (!parsed || fatal) {
      throw new Error(
        `${normalize(relative(projectRoots[0], configPath))}: invalid TypeScript config: ${fatal ?? "unknown parse failure"}`,
      );
    }
    if (parsed.options.paths) {
      mappings.push({
        root,
        base: resolve(parsed.options.pathsBasePath ?? root),
        paths: parsed.options.paths,
      });
    }
  }
  return mappings.sort((left, right) => right.root.length - left.root.length);
}

function compilerImportBases(importer, specifier, mappings) {
  const mapping = mappings.find(({ root }) => isWithin(importer, root));
  if (!mapping) return [];
  return mappedTargets(mapping.paths, specifier).map((target) =>
    resolve(mapping.base, target),
  );
}

function resolveLocalTargets(importer, specifier, context) {
  let base;
  if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else if (isAbsolute(specifier)) base = resolve(specifier);
  else {
    const compilerTargets = compilerImportBases(
      importer,
      specifier,
      context.compilerMappings,
    );
    if (compilerTargets.length > 0)
      return compilerTargets.map(resolveFileTarget);
    return workspaceImportBases(specifier, context.packages).map(
      resolveFileTarget,
    );
  }
  return [resolveFileTarget(base)];
}

export function assertNoExcludedSourceImports(
  paths,
  repository,
  { excludeFixtures = true } = {},
) {
  const repositoryPath = resolve(repository);
  const projectRoots = repositoryProjectRoots(repositoryPath);
  const context = {
    compilerMappings: compilerPathMappings(projectRoots),
    packages: workspacePackages(projectRoots, repositoryPath),
  };
  const failures = [];
  for (const path of paths) {
    const source = parseScript(path);
    for (const reference of moduleReferences(source)) {
      const position = source.getLineAndCharacterOfPosition(
        reference.node.getStart(source),
      );
      const location = `${normalize(relative(repositoryPath, path))}:${position.line + 1}:${position.character + 1}`;
      if (reference.specifier === undefined) {
        failures.push(
          `${location} dynamic import/require must use a statically provable module path`,
        );
        continue;
      }
      const targets = resolveLocalTargets(path, reference.specifier, context);
      for (const target of targets) {
        if (!isWithin(target, repositoryPath)) {
          failures.push(
            `${location} imports source outside repository ownership: ${reference.specifier}`,
          );
          continue;
        }
        const exclusion = exclusionForPath(target, repositoryPath, {
          excludeFixtures,
        });
        if (exclusion && !exclusion.importable) {
          failures.push(
            `${location} imports excluded ${exclusion.provenance}: ${reference.specifier}`,
          );
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Excluded runtime source imports:\n${failures.join("\n")}`);
  }
}

function meaningfulIgnoreLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function assertExactIgnoreLines(repository, path, expected) {
  const actual = meaningfulIgnoreLines(resolve(repository, path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${path} differs from exact generated/vendor ignore policy:\nexpected ${expected.join(", ")}\nactual ${actual.join(", ")}`,
    );
  }
}

export function attestIgnorePolicies(repository) {
  const root = resolve(repository);
  assertExactIgnoreLines(root, ".gitignore", [
    "/node_modules/",
    "/apps/deploy-broker/node_modules/",
    "/apps/gateway/node_modules/",
    "/apps/web/node_modules/",
    "/convex/node_modules/",
    "/packages/shared/node_modules/",
    "/package-lock.json",
    "/yarn.lock",
    "/.DS_Store",
    "/.cache/",
    "/.env",
    "/.vercel/",
    "/.output/",
    "/.nitro/",
    "/build/",
    "/api/",
    "/server/build/",
    "/public/build/",
    "/.env.sentry-build-plugin",
    "/test-results/",
    "/playwright-report/",
    "/blob-report/",
    "/playwright/.cache/",
    "/apps/web/.tanstack/",
    "/apps/web/.wrangler/",
    "/apps/gateway/.wrangler/",
    "/apps/gateway/dist/",
    "/packages/shared/dist/",
    "/dist/",
    "/*.webm",
    "/*-frames/",
    "/frames/",
    "/before-reload.png",
    "/after-reload.png",
    "/error.png",
    "/reload-*.png",
    "/reload-*.webm",
    "/.env*.local",
    "/.turbo/",
    "/apps/gateway/.turbo/",
    "/apps/web/.turbo/",
    "/packages/shared/.turbo/",
    "/e2e/artifacts/",
    "/.project/e2e-key.env",
    "/.dev.vars",
    "/apps/gateway/.dev.vars",
  ]);
  assertExactIgnoreLines(root, "apps/web/.gitignore", [
    "/.DS_Store",
    "/node_modules/",
    "/dist/",
    "/dist-ssr/",
    "/.env*.local",
    "/.env",
    "/.nitro/",
    "/.tanstack/",
    "/.wrangler/",
    "/.output/",
    "/.vinxi/",
    "/__unconfig*",
    "/todos.json",
  ]);
  assertExactIgnoreLines(root, ".prettierignore", [
    "/apps/web/public/",
    "/.agents/skills/",
    "/pnpm-lock.yaml",
    "/apps/web/src/routeTree.gen.ts",
    "/scripts/quality/fixtures/invalid-structured-data/",
    "/apps/web/dist/",
  ]);

  const oxlint = JSON.parse(
    readFileSync(resolve(root, ".oxlintrc.json"), "utf8"),
  );
  const expectedOxlint = [
    "node_modules/**",
    ".cache/**",
    ".vercel/**",
    ".output/**",
    ".nitro/**",
    ".turbo/**",
    "build/**",
    "api/**",
    "server/build/**",
    "public/build/**",
    "dist/**",
    "apps/gateway/node_modules/**",
    "apps/gateway/.turbo/**",
    "apps/gateway/.wrangler/**",
    "apps/gateway/dist/**",
    "apps/web/node_modules/**",
    "convex/node_modules/**",
    "packages/shared/node_modules/**",
    "packages/shared/.turbo/**",
    "packages/shared/dist/**",
    "apps/web/.tanstack/**",
    "apps/web/.nitro/**",
    "apps/web/.output/**",
    "apps/web/.turbo/**",
    "apps/web/.vinxi/**",
    "apps/web/.wrangler/**",
    "apps/web/dist/**",
    "apps/web/dist-ssr/**",
    ".agents/**",
    "apps/web/src/routeTree.gen.ts",
    "convex/_generated/**",
  ];
  if (
    JSON.stringify(oxlint.ignorePatterns ?? []) !==
    JSON.stringify(expectedOxlint)
  ) {
    throw new Error(
      ".oxlintrc.json ignorePatterns differ from exact generated/vendor roots",
    );
  }

  const probes = [
    ["apps/web/dist/probe.ts", true],
    ["apps/web/src/dist/probe.ts", false],
    ["apps/web/.output/probe.ts", true],
    ["apps/web/src/.output/probe.ts", false],
    ["apps/web/node_modules/probe.ts", true],
    ["apps/web/src/node_modules/probe.ts", false],
    ["frames/probe.ts", true],
    ["apps/web/src/frames/probe.ts", false],
    ["capture-frames/probe.ts", true],
    ["apps/web/src/capture-frames/probe.ts", false],
    [".turbo/probe.ts", true],
    ["apps/web/src/.turbo/probe.ts", false],
    ["dist/probe.ts", true],
    ["scripts/dist/probe.ts", false],
    ["apps/gateway/dist/probe.ts", true],
    ["apps/gateway/src/dist/probe.ts", false],
    ["packages/shared/dist/probe.ts", true],
    ["packages/shared/src/dist/probe.ts", false],
  ];
  for (const [path, ignored] of probes) {
    const result = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", path],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    if (result.status !== (ignored ? 0 : 1)) {
      throw new Error(
        `${path}: Git ignore policy expected ignored=${ignored}, status=${result.status}`,
      );
    }
  }
  return probes.length;
}
