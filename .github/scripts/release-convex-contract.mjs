import { execFileSync } from "node:child_process";
import ts from "typescript";

const SHA_RE = /^[0-9a-f]{40}$/;
const FUNCTION_KINDS = new Set(["query", "mutation", "action"]);

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function propertyName(node) {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  throw new Error("Convex contract contains a computed property name");
}

function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

function objectValidator(node, constants, resolving) {
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error("Convex validator object must be an object literal");
  }
  const fields = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("Convex validator object contains an unsupported member");
    }
    fields[propertyName(property.name)] = validator(
      property.initializer,
      constants,
      resolving,
    );
  }
  return { type: "object", fields };
}

function validator(node, constants, resolving = new Set()) {
  if (ts.isParenthesizedExpression(node)) {
    return validator(node.expression, constants, resolving);
  }
  if (ts.isIdentifier(node)) {
    const value = constants.get(node.text);
    if (value === undefined) return { type: "reference", name: node.text };
    if (resolving.has(node.text)) {
      throw new Error(`Recursive Convex validator: ${node.text}`);
    }
    return validator(value, constants, new Set([...resolving, node.text]));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return objectValidator(node, constants, resolving);
  }
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "v"
  ) {
    throw new Error("Unsupported Convex validator expression");
  }
  const kind = node.expression.name.text;
  if (
    ["string", "number", "float64", "boolean", "bytes", "any", "null"].includes(
      kind,
    )
  ) {
    if (node.arguments.length !== 0) {
      throw new Error(`v.${kind} validator has unexpected arguments`);
    }
    return { type: kind === "float64" ? "number" : kind };
  }
  if (kind === "id") {
    const table =
      node.arguments.length === 1 ? literal(node.arguments[0]) : null;
    if (typeof table !== "string") throw new Error("v.id table is not literal");
    return { type: "id", table };
  }
  if (kind === "literal") {
    if (node.arguments.length !== 1)
      throw new Error("v.literal arity is invalid");
    const value = literal(node.arguments[0]);
    if (value === undefined) throw new Error("v.literal value is not literal");
    return { type: "literal", value };
  }
  if (["optional", "array"].includes(kind)) {
    if (node.arguments.length !== 1)
      throw new Error(`v.${kind} arity is invalid`);
    return {
      type: kind,
      value: validator(node.arguments[0], constants, resolving),
    };
  }
  if (kind === "object") {
    if (node.arguments.length !== 1)
      throw new Error("v.object arity is invalid");
    return objectValidator(node.arguments[0], constants, resolving);
  }
  if (kind === "union") {
    if (node.arguments.length === 0) throw new Error("v.union cannot be empty");
    return {
      type: "union",
      values: node.arguments
        .map((argument) => validator(argument, constants, resolving))
        .sort((left, right) =>
          JSON.stringify(canonical(left)).localeCompare(
            JSON.stringify(canonical(right)),
          ),
        ),
    };
  }
  throw new Error(`Unsupported Convex validator v.${kind}`);
}

function accepts(candidate, base) {
  if (equal(candidate, base) || candidate.type === "any") return true;
  if (candidate.type === "optional") {
    return accepts(
      candidate.value,
      base.type === "optional" ? base.value : base,
    );
  }
  if (base.type === "optional") return false;
  if (candidate.type === "union") {
    const baseValues = base.type === "union" ? base.values : [base];
    return baseValues.every((value) =>
      candidate.values.some((option) => accepts(option, value)),
    );
  }
  if (base.type === "union") {
    return base.values.every((value) => accepts(candidate, value));
  }
  if (base.type === "literal") {
    if (candidate.type === typeof base.value) return true;
    if (candidate.type === "number" && typeof base.value === "number")
      return true;
  }
  if (candidate.type === "array" && base.type === "array") {
    return accepts(candidate.value, base.value);
  }
  if (candidate.type === "object" && base.type === "object") {
    for (const [name, baseField] of Object.entries(base.fields)) {
      const candidateField = candidate.fields[name];
      if (candidateField === undefined || !accepts(candidateField, baseField)) {
        return false;
      }
    }
    for (const [name, candidateField] of Object.entries(candidate.fields)) {
      if (
        base.fields[name] === undefined &&
        candidateField.type !== "optional"
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function sourceAt(sha, path) {
  return git(["show", `${sha}:${path}`]);
}

function sourceFilesAt(sha) {
  const output = git(["ls-tree", "-r", "--name-only", sha, "--", "convex"]);
  return output
    .split("\n")
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.includes("/_generated/") &&
        !path.endsWith(".test.ts") &&
        !path.endsWith(".config.ts"),
    )
    .sort();
}

function parseSource(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse Convex contract source ${path}`);
  }
  return source;
}

function constantsIn(source) {
  const constants = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return constants;
}

function objectProperty(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    ) {
      return property.name;
    }
    if (
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function tableDefinition(node, constants) {
  const indexes = [];
  let current = node;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    const method = current.expression.name.text;
    if (!["index", "searchIndex", "vectorIndex"].includes(method)) {
      throw new Error(`Unsupported Convex table method: ${method}`);
    }
    const name =
      current.arguments.length > 0 ? literal(current.arguments[0]) : null;
    if (typeof name !== "string")
      throw new Error("Convex index name is not literal");
    indexes.push({ method, name });
    current = current.expression.expression;
  }
  if (
    !ts.isCallExpression(current) ||
    !ts.isIdentifier(current.expression) ||
    current.expression.text !== "defineTable" ||
    current.arguments.length !== 1
  ) {
    throw new Error("Unsupported Convex table definition");
  }
  return {
    fields: objectValidator(current.arguments[0], constants),
    indexes: indexes.sort((left, right) =>
      `${left.method}:${left.name}`.localeCompare(
        `${right.method}:${right.name}`,
      ),
    ),
  };
}

function schemaInventory(source, constants) {
  const exportDefault = source.statements.find(ts.isExportAssignment);
  if (
    exportDefault === undefined ||
    !ts.isCallExpression(exportDefault.expression) ||
    !ts.isIdentifier(exportDefault.expression.expression) ||
    exportDefault.expression.expression.text !== "defineSchema" ||
    exportDefault.expression.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(exportDefault.expression.arguments[0])
  ) {
    throw new Error("convex/schema.ts must export defineSchema object literal");
  }
  const tables = {};
  for (const property of exportDefault.expression.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("Convex schema contains unsupported table syntax");
    }
    tables[propertyName(property.name)] = tableDefinition(
      property.initializer,
      constants,
    );
  }
  return tables;
}

function exported(statement) {
  return statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function functionInventory(path, source, constants) {
  const functions = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !exported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isCallExpression(declaration.initializer) ||
        !ts.isIdentifier(declaration.initializer.expression) ||
        !FUNCTION_KINDS.has(declaration.initializer.expression.text) ||
        declaration.initializer.arguments.length !== 1
      ) {
        continue;
      }
      const definition = declaration.initializer.arguments[0];
      const args = objectProperty(definition, "args");
      if (args === undefined) {
        throw new Error(
          `Convex function ${path}:${declaration.name.text} has no args`,
        );
      }
      const returns = objectProperty(definition, "returns");
      functions[
        `${path.slice("convex/".length, -3)}:${declaration.name.text}`
      ] = {
        kind: declaration.initializer.expression.text,
        args: objectValidator(args, constants),
        returns: returns === undefined ? null : validator(returns, constants),
      };
    }
  }
  return functions;
}

function httpInventory(source) {
  const routes = {};
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "http" &&
      node.expression.name.text === "route" &&
      node.arguments.length === 1
    ) {
      const pathNode = objectProperty(node.arguments[0], "path");
      const methodNode = objectProperty(node.arguments[0], "method");
      if (pathNode === undefined && methodNode === undefined) {
        ts.forEachChild(node, visit);
        return;
      }
      const path = pathNode === undefined ? null : literal(pathNode);
      const method = methodNode === undefined ? null : literal(methodNode);
      if (
        pathNode !== undefined &&
        ts.isShorthandPropertyAssignment(pathNode.parent)
      ) {
        // Route factories are represented by their stable declaration call.
        // A semantic factory change still alters this source file's contract
        // digest and requires explicit review when a route disappears.
        const declaredPaths = source.statements
          .filter(ts.isExpressionStatement)
          .map((statement) => statement.expression)
          .filter(
            (expression) =>
              ts.isCallExpression(expression) &&
              ts.isIdentifier(expression.expression) &&
              expression.expression.text === "stripeWebhookRoute" &&
              expression.arguments.length > 0,
          )
          .map((expression) => literal(expression.arguments[0]))
          .filter((value) => typeof value === "string");
        for (const declaredPath of declaredPaths) {
          routes[`${String(method)}:${declaredPath}`] = true;
        }
        return;
      }
      if (typeof path !== "string" || typeof method !== "string") {
        const sourceFile = node.getSourceFile();
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(),
        );
        throw new Error(
          `Convex HTTP route identity must be literal at ${sourceFile.fileName}:${location.line + 1}`,
        );
      }
      routes[`${method}:${path}`] = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}

export function convexContractAt(sha) {
  if (!SHA_RE.test(sha ?? ""))
    throw new Error("Convex contract SHA is invalid");
  const inventory = { tables: {}, functions: {}, routes: {} };
  for (const path of sourceFilesAt(sha)) {
    const source = parseSource(path, sourceAt(sha, path));
    const constants = constantsIn(source);
    if (path === "convex/schema.ts") {
      inventory.tables = schemaInventory(source, constants);
    }
    Object.assign(
      inventory.functions,
      functionInventory(path, source, constants),
    );
    if (path === "convex/http.ts") {
      Object.assign(inventory.routes, httpInventory(source));
    }
  }
  if (Object.keys(inventory.tables).length === 0) {
    throw new Error("Convex contract has no schema tables");
  }
  return canonical(inventory);
}

export function classifyConvexContract(baseSha, candidateSha) {
  const base = convexContractAt(baseSha);
  const candidate = convexContractAt(candidateSha);
  const reasons = [];
  for (const [name, table] of Object.entries(base.tables)) {
    const next = candidate.tables[name];
    if (next === undefined) {
      reasons.push(`table removed: ${name}`);
      continue;
    }
    if (!accepts(next.fields, table.fields)) {
      reasons.push(`table validator narrowed: ${name}`);
    }
    const candidateIndexes = new Set(
      next.indexes.map((index) => `${index.method}:${index.name}`),
    );
    for (const index of table.indexes) {
      const identity = `${index.method}:${index.name}`;
      if (!candidateIndexes.has(identity)) {
        reasons.push(`index removed: ${name}.${index.name}`);
      }
    }
  }
  for (const [name, fn] of Object.entries(base.functions)) {
    const next = candidate.functions[name];
    if (next === undefined) {
      reasons.push(`function removed: ${name}`);
      continue;
    }
    if (next.kind !== fn.kind) reasons.push(`function kind changed: ${name}`);
    if (!accepts(next.args, fn.args))
      reasons.push(`function args narrowed: ${name}`);
    if (!equal(next.returns, fn.returns)) {
      reasons.push(`function return validator changed: ${name}`);
    }
  }
  for (const route of Object.keys(base.routes)) {
    if (candidate.routes[route] !== true)
      reasons.push(`HTTP route removed: ${route}`);
  }
  return {
    hasChange: !equal(base, candidate),
    hasContraction: reasons.length > 0,
    reasons,
  };
}
