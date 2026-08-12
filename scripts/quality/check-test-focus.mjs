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
        ) {
          continue;
        }
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

function calleeSegments(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    return [...calleeSegments(expression.expression), expression.name.text];
  }
  return [];
}

export function findBlockedTests(roots, { excludeFixtures = false } = {}) {
  const violations = [];

  for (const root of roots) {
    for (const path of collectScripts(root, excludeFixtures)) {
      const source = readFileSync(path, "utf8");
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      function visit(node) {
        if (ts.isCallExpression(node)) {
          const segments = calleeSegments(node.expression);
          const aliasBlocked =
            segments.length === 1 && blockedAliases.has(segments[0]);
          const modifierBlocked =
            testFunctions.has(segments[0]) &&
            segments.some((segment) => blockedModifiers.has(segment));
          if (aliasBlocked || modifierBlocked) {
            const position = file.getLineAndCharacterOfPosition(
              node.getStart(file),
            );
            violations.push(
              `${relative(repositoryRoot, path)}:${position.line + 1}:${position.character + 1} ${segments.join(".")}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(file);
    }
  }

  return violations;
}

if (process.argv[1] === import.meta.filename) {
  const explicitRoots = process.argv.slice(2).map((path) => resolve(path));
  const roots = explicitRoots.length > 0 ? explicitRoots : [repositoryRoot];
  const violations = findBlockedTests(roots, {
    excludeFixtures: explicitRoots.length === 0,
  });
  if (violations.length > 0) {
    process.stderr.write(
      `Skipped/focused tests are forbidden:\n${violations.join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("Skipped/focused tests: 0\n");
  }
}
