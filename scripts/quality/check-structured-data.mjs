import { readFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import ts from "typescript";
import { parseDocument } from "yaml";
import {
  collectOwnedFiles,
  structuredDataExtensions,
} from "./source-inventory.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
function collectFiles(root, excludeFixtures) {
  return collectOwnedFiles({
    roots: [root],
    repository: repositoryRoot,
    extensions: structuredDataExtensions,
    excludeFixtures,
  });
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
