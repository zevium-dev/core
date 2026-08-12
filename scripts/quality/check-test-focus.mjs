import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
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
const scriptExtensions = [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"];
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
const unknown = Object.freeze({ kind: "unknown" });

function runner(root, segments = [root]) {
  return { kind: "runner", root, segments };
}

function stringValue(value) {
  return { kind: "string", value };
}

function recordValue(properties = {}) {
  return { kind: "record", properties };
}

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
        scriptExtensions.includes(extname(entry.name)) &&
        entry.name !== "routeTree.gen.ts" &&
        !relative(repositoryRoot, path).startsWith("convex/_generated/")
      ) {
        files.push(resolve(path));
      }
    }
  }
  visit(root);
  return files.sort();
}

class Environment {
  constructor(parent) {
    this.parent = parent;
    this.values = new Map();
  }

  declare(name, value = unknown) {
    this.values.set(name, value);
  }

  get(name) {
    if (this.values.has(name)) return this.values.get(name);
    return this.parent?.get(name) ?? unknown;
  }

  assign(name, value) {
    if (this.values.has(name)) this.values.set(name, value);
    else if (this.parent) this.parent.assign(name, value);
    else this.values.set(name, value);
  }
}

function unwrap(expression) {
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
  return current;
}

function evaluateString(expression, environment) {
  const current = unwrap(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isTemplateExpression(current) && current.templateSpans.length === 0)
    return current.head.text;
  if (ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts.isIdentifier(current)) {
    const value = environment.get(current.text);
    return value.kind === "string" ? value.value : undefined;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateString(current.left, environment);
    const right = evaluateString(current.right, environment);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function propertyName(expression, environment) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    !ts.isElementAccessExpression(expression) ||
    !expression.argumentExpression
  )
    return undefined;
  return evaluateString(expression.argumentExpression, environment);
}

function memberValue(value, property) {
  if (!property) return unknown;
  if (value.kind === "runner")
    return runner(value.root, [...value.segments, property]);
  if (value.kind === "record") return value.properties[property] ?? unknown;
  return unknown;
}

function evaluate(expression, environment) {
  const current = unwrap(expression);
  const text = evaluateString(current, environment);
  if (text !== undefined) return stringValue(text);
  if (ts.isIdentifier(current)) return environment.get(current.text);
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const base = evaluate(current.expression, environment);
    const property = propertyName(current, environment);
    return memberValue(base, property);
  }
  if (ts.isCallExpression(current)) {
    const callee = evaluate(current.expression, environment);
    return callee.kind === "runner" ? callee : unknown;
  }
  if (ts.isTaggedTemplateExpression(current)) {
    const tag = evaluate(current.tag, environment);
    return tag.kind === "runner" ? tag : unknown;
  }
  if (ts.isObjectLiteralExpression(current)) {
    const properties = {};
    for (const element of current.properties) {
      if (ts.isSpreadAssignment(element)) {
        const spread = evaluate(element.expression, environment);
        if (spread.kind === "record")
          Object.assign(properties, spread.properties);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(element)) {
        properties[element.name.text] = environment.get(element.name.text);
        continue;
      }
      if (!ts.isPropertyAssignment(element)) continue;
      const property = ts.isComputedPropertyName(element.name)
        ? evaluateString(element.name.expression, environment)
        : element.name.text;
      if (property)
        properties[property] = evaluate(element.initializer, environment);
    }
    return recordValue(properties);
  }
  if (ts.isConditionalExpression(current)) {
    const left = evaluate(current.whenTrue, environment);
    const right = evaluate(current.whenFalse, environment);
    return JSON.stringify(left) === JSON.stringify(right) ? left : unknown;
  }
  return unknown;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function bindPattern(name, value, environment) {
  if (ts.isIdentifier(name)) {
    environment.assign(name.text, value);
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        for (const binding of bindingNames(element.name))
          environment.assign(binding, unknown);
        continue;
      }
      const property = element.propertyName
        ? ts.isComputedPropertyName(element.propertyName)
          ? evaluateString(element.propertyName.expression, environment)
          : element.propertyName.text
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
      const member = memberValue(value, property);
      bindPattern(element.name, member, environment);
    }
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element))
      bindPattern(element.name, unknown, environment);
  }
}

function assignPattern(node, value, environment) {
  const current = unwrap(node);
  if (ts.isIdentifier(current)) {
    environment.assign(current.text, value);
    return;
  }
  if (ts.isObjectLiteralExpression(current)) {
    for (const element of current.properties) {
      if (ts.isShorthandPropertyAssignment(element)) {
        environment.assign(
          element.name.text,
          memberValue(value, element.name.text),
        );
        continue;
      }
      if (!ts.isPropertyAssignment(element)) continue;
      const property = ts.isComputedPropertyName(element.name)
        ? evaluateString(element.name.expression, environment)
        : element.name.text;
      assignPattern(
        element.initializer,
        memberValue(value, property),
        environment,
      );
    }
    return;
  }
  if (ts.isArrayLiteralExpression(current)) {
    for (const element of current.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isSpreadElement(element))
        assignPattern(element.expression, unknown, environment);
      else assignPattern(element, unknown, environment);
    }
    return;
  }
  if (
    (ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)) &&
    ts.isIdentifier(current.expression)
  ) {
    const property = propertyName(current, environment);
    const base = environment.get(current.expression.text);
    if (property && base.kind === "record") {
      environment.assign(
        current.expression.text,
        recordValue({ ...base.properties, [property]: value }),
      );
    }
  }
}

function predeclareStatements(statements, environment) {
  for (const statement of statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) environment.declare(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          environment.declare(clause.namedBindings.name.text);
        else
          for (const element of clause.namedBindings.elements)
            environment.declare(element.name.text);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        for (const name of bindingNames(declaration.name))
          environment.declare(name);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      environment.declare(statement.name.text);
    }
  }
}

function resolveLocalModule(path, specifier, sources) {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(path), specifier);
  const candidates = [
    base,
    ...scriptExtensions.map((extension) => `${base}${extension}`),
    ...scriptExtensions.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => sources.has(candidate));
}

function importedValue(path, specifier, imported, sources, exportMaps) {
  if (testModules.has(specifier)) {
    if (imported === "*") return runner("runner", []);
    if (testFunctions.has(imported) || blockedAliases.has(imported))
      return runner(imported);
    return unknown;
  }
  const local = resolveLocalModule(path, specifier, sources);
  if (!local) return unknown;
  const exports = exportMaps.get(local) ?? new Map();
  return imported === "*"
    ? recordValue(Object.fromEntries(exports))
    : (exports.get(imported) ?? unknown);
}

function loadImports(info, environment, sources, exportMaps) {
  for (const statement of info.source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name)
      environment.assign(
        clause.name.text,
        importedValue(info.path, specifier, "default", sources, exportMaps),
      );
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      environment.assign(
        clause.namedBindings.name.text,
        importedValue(info.path, specifier, "*", sources, exportMaps),
      );
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        environment.assign(
          element.name.text,
          importedValue(info.path, specifier, imported, sources, exportMaps),
        );
      }
    }
  }
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function summarizeModule(info, sources, exportMaps) {
  const environment = new Environment();
  predeclareStatements(info.source.statements, environment);
  loadImports(info, environment, sources, exportMaps);
  const exports = new Map();
  const exportedLocals = new Map();

  for (const statement of info.source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer
          ? evaluate(declaration.initializer, environment)
          : unknown;
        bindPattern(declaration.name, value, environment);
        if (hasExportModifier(statement)) {
          for (const name of bindingNames(declaration.name))
            exportedLocals.set(name, name);
        }
      }
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(statement.expression.left)
    ) {
      environment.assign(
        statement.expression.left.text,
        evaluate(statement.expression.right, environment),
      );
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exports.set("default", evaluate(statement.expression, environment));
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!statement.exportClause) {
      if (!specifier) continue;
      const local = resolveLocalModule(info.path, specifier, sources);
      for (const [name, value] of exportMaps.get(local) ?? [])
        exports.set(name, value);
      if (testModules.has(specifier)) {
        for (const name of [...testFunctions, ...blockedAliases])
          exports.set(name, runner(name));
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const value = specifier
        ? importedValue(info.path, specifier, imported, sources, exportMaps)
        : environment.get(imported);
      exports.set(element.name.text, value);
      if (!specifier) exportedLocals.set(element.name.text, imported);
    }
  }
  for (const [exported, local] of exportedLocals)
    exports.set(exported, environment.get(local));
  return exports;
}

function buildExportMaps(sources) {
  const maps = new Map([...sources.keys()].map((path) => [path, new Map()]));
  for (let iteration = 0; iteration < sources.size + 1; iteration += 1) {
    let changed = false;
    for (const info of sources.values()) {
      const next = summarizeModule(info, sources, maps);
      if (
        JSON.stringify([...next]) !==
        JSON.stringify([...(maps.get(info.path) ?? [])])
      ) {
        maps.set(info.path, next);
        changed = true;
      }
    }
    if (!changed) return maps;
  }
  throw new Error("Test wrapper export graph did not converge");
}

function isBlockedCall(value) {
  if (value.kind !== "runner") return false;
  const runnerCall =
    testFunctions.has(value.root) ||
    blockedAliases.has(value.root) ||
    (value.root === "runner" &&
      value.segments.some(
        (segment) => testFunctions.has(segment) || blockedAliases.has(segment),
      ));
  return (
    runnerCall &&
    value.segments.some(
      (segment) => blockedModifiers.has(segment) || blockedAliases.has(segment),
    )
  );
}

function scanSource(info, sources, exportMaps) {
  const violations = [];
  const root = new Environment();
  predeclareStatements(info.source.statements, root);
  loadImports(info, root, sources, exportMaps);
  if (/(?:^|[/\\])[^/\\]+\.(?:test|spec)\.[^.]+$/.test(info.path)) {
    for (const name of [...testFunctions, ...blockedAliases]) {
      if (!root.values.has(name)) root.declare(name, runner(name));
    }
  }

  function report(node, value) {
    if (!isBlockedCall(value)) return;
    const position = info.source.getLineAndCharacterOfPosition(
      node.getStart(info.source),
    );
    violations.push(
      `${relative(repositoryRoot, info.path)}:${position.line + 1}:${position.character + 1} ${value.segments.join(".")}`,
    );
  }

  function visit(node, environment) {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isBlock(node)) {
      const block = new Environment(environment);
      predeclareStatements(node.statements, block);
      for (const statement of node.statements) visit(statement, block);
      return;
    }
    if (ts.isFunctionLike(node)) {
      const scope = new Environment(environment);
      for (const parameter of node.parameters) {
        for (const name of bindingNames(parameter.name)) scope.declare(name);
        if (parameter.initializer) visit(parameter.initializer, environment);
      }
      if (node.body) visit(node.body, scope);
      return;
    }
    if (ts.isCatchClause(node)) {
      const scope = new Environment(environment);
      if (node.variableDeclaration)
        for (const name of bindingNames(node.variableDeclaration.name))
          scope.declare(name);
      visit(node.block, scope);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer, environment);
      bindPattern(
        node.name,
        node.initializer ? evaluate(node.initializer, environment) : unknown,
        environment,
      );
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      visit(node.right, environment);
      const value = evaluate(node.right, environment);
      assignPattern(node.left, value, environment);
      return;
    }
    if (ts.isCallExpression(node))
      report(node, evaluate(node.expression, environment));
    if (ts.isTaggedTemplateExpression(node))
      report(node, evaluate(node.tag, environment));
    ts.forEachChild(node, (child) => visit(child, environment));
  }

  for (const statement of info.source.statements) visit(statement, root);
  return violations;
}

export function findBlockedTests(roots, { excludeFixtures = false } = {}) {
  const paths = [
    ...new Set(roots.flatMap((root) => collectScripts(root, excludeFixtures))),
  ];
  const sources = new Map(
    paths.map((path) => {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
      return [path, { path, source }];
    }),
  );
  const exportMaps = buildExportMaps(sources);
  return [...sources.values()].flatMap((info) =>
    scanSource(info, sources, exportMaps),
  );
}

if (process.argv[1] === import.meta.filename) {
  const explicitRoots = process.argv.slice(2).map((path) => resolve(path));
  const roots = explicitRoots.length ? explicitRoots : [repositoryRoot];
  try {
    const violations = findBlockedTests(roots, {
      excludeFixtures: explicitRoots.length === 0,
    });
    if (violations.length) {
      process.stderr.write(
        `Skipped/focused tests are forbidden:\n${violations.join("\n")}\n`,
      );
      process.exitCode = 1;
    } else process.stdout.write("Skipped/focused tests: 0\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
