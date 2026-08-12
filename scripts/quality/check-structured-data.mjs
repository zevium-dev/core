import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { parseDocument } from "yaml";

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
const supportedExtensions = new Set([".json", ".jsonc", ".yaml", ".yml"]);

function collectFiles(root, excludeFixtures) {
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
      } else if (supportedExtensions.has(extname(entry.name))) {
        files.push(path);
      }
    }
  }

  visit(root);
  return files;
}

function parseJsonLike(path, source) {
  const isJsonWithComments =
    extname(path) === ".jsonc" || basename(path).startsWith("tsconfig");
  if (!isJsonWithComments) {
    JSON.parse(source);
    return;
  }

  const parsed = ts.parseConfigFileTextToJson(path, source);
  if (parsed.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
    );
  }
}

export function checkStructuredData(roots, { excludeFixtures = false } = {}) {
  const failures = [];
  let checked = 0;

  for (const root of roots) {
    for (const path of collectFiles(root, excludeFixtures)) {
      checked += 1;
      try {
        const source = readFileSync(path, "utf8");
        if ([".yaml", ".yml"].includes(extname(path))) {
          const document = parseDocument(source, {
            prettyErrors: false,
            uniqueKeys: true,
          });
          if (document.errors.length > 0) {
            throw new Error(
              document.errors.map((error) => error.message).join("; "),
            );
          }
        } else {
          parseJsonLike(path, source);
        }
      } catch (error) {
        failures.push(
          `${relative(repositoryRoot, path)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Structured-data parse failures:\n${failures.join("\n")}`);
  }
  return checked;
}

if (process.argv[1] === import.meta.filename) {
  const explicitRoots = process.argv.slice(2).map((path) => resolve(path));
  const roots = explicitRoots.length > 0 ? explicitRoots : [repositoryRoot];
  try {
    const count = checkStructuredData(roots, {
      excludeFixtures: explicitRoots.length === 0,
    });
    process.stdout.write(`Structured data parsed: ${count} files\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
