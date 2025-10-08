import type { PluginOption, ResolvedConfig } from "vite";

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRE_PATTERN = /(var|let|const)\s+(\{[^}]+\}|[\w$]+)\s*=\s*__require\("(node:[^"]+)"\);/g;

interface ImportDescriptor {
  defaultImports: Set<string>;
  namedImports: Set<string>;
}

export function nodeBuiltinImportPostprocess(): PluginOption {
  let resolvedConfig: null | ResolvedConfig = null;

  return {
    apply: "build",
    async closeBundle() {
      if (!resolvedConfig) {
        return;
      }

      const outDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir);

      await rewriteNodeImports(outDir);
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    name: "node-builtin-import-postprocess",
  } satisfies PluginOption;
}

function buildImportStatements(imports: Map<string, ImportDescriptor>): Array<string> {
  const statements: Array<string> = [];

  for (const [specifier, descriptor] of imports) {
    const named = descriptor.namedImports.size ? `{ ${Array.from(descriptor.namedImports).join(", ")} }` : null;

    for (const def of descriptor.defaultImports) {
      statements.push(`import ${def} from "${specifier}";`);
    }

    if (named) {
      statements.push(`import ${named} from "${specifier}";`);
    }
  }

  return statements;
}

async function collectJsFiles(dir: string): Promise<Array<string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<string> = [];

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await collectJsFiles(fullPath)));
        return;
      }

      if (entry.isFile() && fullPath.endsWith(".js")) {
        files.push(fullPath);
      }
    }),
  );

  return files;
}

function injectImports(code: string, importStatements: Array<string>): string {
  if (importStatements.length === 0) {
    return code;
  }

  let shebang = "";
  let rest = code;

  if (rest.startsWith("#!")) {
    const newlineIndex = rest.indexOf("\n");
    if (newlineIndex !== -1) {
      shebang = rest.slice(0, newlineIndex + 1);
      rest = rest.slice(newlineIndex + 1);
    } else {
      shebang = rest;
      rest = "";
    }
  }

  const trimmedRest = rest.trimStart();
  const separator = trimmedRest.length > 0 ? "\n\n" : "\n";
  const importBlock = importStatements.join("\n");

  return `${shebang}${importBlock}${separator}${trimmedRest}`;
}

async function rewriteNodeImports(outDir: string) {
  let directoryStats;
  try {
    directoryStats = await stat(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (!directoryStats.isDirectory()) {
    return;
  }

  const jsFiles = await collectJsFiles(outDir);

  await Promise.all(jsFiles.map((file) => transformFile(file)));
}

async function transformFile(filePath: string) {
  const original = await readFile(filePath, "utf8");
  const matches = Array.from(original.matchAll(REQUIRE_PATTERN));

  if (matches.length === 0) {
    return;
  }

  const imports = new Map<string, ImportDescriptor>();

  for (const match of matches) {
    const bindingRaw = match.at(2)?.trim();
    const specifier = match.at(3);
    if (!bindingRaw || !specifier) {
      continue;
    }
    const entry =
      imports.get(specifier) ??
      ({
        defaultImports: new Set<string>(),
        namedImports: new Set<string>(),
      } satisfies ImportDescriptor);

    if (bindingRaw.startsWith("{")) {
      const inner = bindingRaw.slice(1, -1);
      inner
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .forEach((token) => entry.namedImports.add(token));
    } else {
      entry.defaultImports.add(bindingRaw);
    }

    imports.set(specifier, entry);
  }

  const cleaned = original.replace(REQUIRE_PATTERN, "");
  const rewritten = injectImports(cleaned, buildImportStatements(imports));

  await writeFile(filePath, rewritten, "utf8");
}
