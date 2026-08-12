import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const ignoredDirectories = new Set([
  ".git",
  ".nitro",
  ".output",
  ".tanstack",
  ".turbo",
  ".wrangler",
  "dist",
  "node_modules",
]);
const scriptExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const testFunctions = new Set(["describe", "it", "suite", "test"]);
const blockedModifiers = new Set(["only", "skip", "skipIf", "todo"]);
const blockedAliases = new Set([
  "fdescribe",
  "fit",
  "xdescribe",
  "xit",
  "xtest",
]);
const testModules = new Set([
  "vitest",
  "node:test",
  "@jest/globals",
  "bun:test",
  "@playwright/test",
]);

function collectScripts(root, excludeFixtures) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        if (
          excludeFixtures &&
          relative(repositoryRoot, path).startsWith("scripts/quality/fixtures")
        )
          continue;
        visit(path);
      } else if (
        scriptExtensions.has(extname(entry.name)) &&
        entry.name !== "routeTree.gen.ts" &&
        !relative(repositoryRoot, path).startsWith("convex/_generated/")
      ) {
        files.push(path);
      }
    }
  }
  visit(root);
  return files;
}

function propertyName(expression, strings) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    !ts.isElementAccessExpression(expression) ||
    !expression.argumentExpression
  )
    return undefined;
  const key = expression.argumentExpression;
  if (ts.isStringLiteralLike(key)) return key.text;
  return ts.isIdentifier(key) ? strings.get(key.text) : undefined;
}

function descriptor(expression, bindings, strings) {
  if (ts.isIdentifier(expression)) return bindings.get(expression.text);
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return descriptor(expression.expression, bindings, strings);
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const base = descriptor(expression.expression, bindings, strings);
    const property = propertyName(expression, strings);
    return base && property
      ? { root: base.root, segments: [...base.segments, property] }
      : undefined;
  }
  return undefined;
}

function bindName(name, value, bindings) {
  if (ts.isIdentifier(name)) {
    if (value) bindings.set(name.text, value);
    return;
  }
  if (!ts.isObjectBindingPattern(name) || !value) return;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const property = element.propertyName
      ? ts.isIdentifier(element.propertyName) ||
        ts.isStringLiteralLike(element.propertyName)
        ? element.propertyName.text
        : undefined
      : element.name.text;
    if (property)
      bindings.set(element.name.text, {
        root: value.root,
        segments: [...value.segments, property],
      });
  }
}

function scanFile(path) {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = new Map();
  const strings = new Map();
  const isTestFile = /(?:^|\.)((?:test|spec))\.[^.]+$/.test(path);
  if (isTestFile) {
    for (const name of testFunctions)
      bindings.set(name, { root: name, segments: [name] });
    for (const name of blockedAliases)
      bindings.set(name, { root: name, segments: [name] });
  }

  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      testModules.has(statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause;
      if (clause?.name)
        bindings.set(clause.name.text, { root: "test", segments: ["test"] });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (testFunctions.has(imported) || blockedAliases.has(imported))
            bindings.set(element.name.text, {
              root: imported,
              segments: [imported],
            });
        }
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.set(clause.namedBindings.name.text, {
          root: "runner",
          segments: [],
        });
      }
    }
  }

  const violations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (
        ts.isIdentifier(node.name) &&
        ts.isStringLiteralLike(node.initializer)
      )
        strings.set(node.name.text, node.initializer.text);
      bindName(
        node.name,
        descriptor(node.initializer, bindings, strings),
        bindings,
      );
    }
    if (ts.isCallExpression(node)) {
      const call = descriptor(node.expression, bindings, strings);
      if (call) {
        const aliasBlocked = call.segments.some((segment) =>
          blockedAliases.has(segment),
        );
        const modifierBlocked = call.segments.some((segment) =>
          blockedModifiers.has(segment),
        );
        const runnerCall =
          testFunctions.has(call.root) ||
          blockedAliases.has(call.root) ||
          call.root === "runner";
        if (runnerCall && (aliasBlocked || modifierBlocked)) {
          const position = file.getLineAndCharacterOfPosition(
            node.getStart(file),
          );
          violations.push(
            `${relative(repositoryRoot, path)}:${position.line + 1}:${position.character + 1} ${call.segments.join(".")}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

export function findBlockedTests(roots, { excludeFixtures = false } = {}) {
  return roots.flatMap((root) =>
    collectScripts(root, excludeFixtures).flatMap(scanFile),
  );
}

if (process.argv[1] === import.meta.filename) {
  const explicitRoots = process.argv.slice(2).map((path) => resolve(path));
  const roots = explicitRoots.length ? explicitRoots : [repositoryRoot];
  const violations = findBlockedTests(roots, {
    excludeFixtures: explicitRoots.length === 0,
  });
  if (violations.length) {
    process.stderr.write(
      `Skipped/focused tests are forbidden:\n${violations.join("\n")}\n`,
    );
    process.exitCode = 1;
  } else process.stdout.write("Skipped/focused tests: 0\n");
}
