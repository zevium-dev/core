import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SHA_RE = /^[0-9a-f]{40}$/;
const FUNCTION_KINDS = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);
const INDEX_METHODS = new Set(["index", "searchIndex", "vectorIndex"]);
const NUMBER_VALIDATORS = new Set(["number", "float64"]);
const KNOWN_VALIDATOR_IMPORTS = new Map([
  [
    "convex/server:paginationOptsValidator",
    {
      type: "object",
      source: "convex/server:paginationOptsValidator",
      fields: {
        numItems: { type: "number" },
        cursor: {
          type: "union",
          values: [{ type: "null" }, { type: "string" }],
        },
        endCursor: {
          type: "optional",
          value: {
            type: "union",
            values: [{ type: "null" }, { type: "string" }],
          },
        },
        id: { type: "optional", value: { type: "number" } },
        maximumRowsRead: {
          type: "optional",
          value: { type: "number" },
        },
        maximumBytesRead: {
          type: "optional",
          value: { type: "number" },
        },
      },
    },
  ],
]);

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

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
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

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalAst(node) {
  const current = unwrap(node);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return { kind: "string", value: current.text };
  }
  if (ts.isNumericLiteral(current)) {
    const value = Number(current.text);
    if (!Number.isFinite(value))
      throw new Error("Numeric literal is not finite");
    return { kind: "number", value };
  }
  if (ts.isBigIntLiteral(current)) {
    return { kind: "bigint", value: current.text.replace(/n$/, "") };
  }
  if (
    ts.isPrefixUnaryExpression(current) &&
    (current.operator === ts.SyntaxKind.MinusToken ||
      current.operator === ts.SyntaxKind.PlusToken)
  ) {
    if (ts.isNumericLiteral(current.operand)) {
      const magnitude = Number(current.operand.text);
      const value =
        current.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude;
      if (!Number.isFinite(value))
        throw new Error("Numeric literal is not finite");
      return { kind: "number", value };
    }
    if (ts.isBigIntLiteral(current.operand)) {
      const magnitude = current.operand.text.replace(/n$/, "");
      return {
        kind: "bigint",
        value:
          current.operator === ts.SyntaxKind.MinusToken
            ? `-${magnitude}`
            : magnitude,
      };
    }
  }
  if (current.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolean", value: true };
  }
  if (current.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: false };
  }
  if (current.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "null", value: null };
  }
  return undefined;
}

function resolveConstant(node, constants, resolving) {
  const current = unwrap(node);
  if (!ts.isIdentifier(current)) return current;
  const value = constants.get(current.text);
  if (value === undefined) return current;
  if (value.knownValidator !== undefined) {
    throw new Error(
      `Known validator ${current.text} used outside a validator position`,
    );
  }
  if (resolving.has(current.text)) {
    throw new Error(`Recursive Convex contract constant: ${current.text}`);
  }
  return resolveConstant(
    value,
    constants,
    new Set([...resolving, current.text]),
  );
}

function expressionAst(node, constants, resolving = new Set()) {
  const current = resolveConstant(node, constants, resolving);
  const scalar = literalAst(current);
  if (scalar !== undefined) return scalar;
  if (ts.isIdentifier(current)) {
    return { kind: "reference", name: current.text };
  }
  if (ts.isArrayLiteralExpression(current)) {
    return {
      kind: "array",
      values: current.elements.map((entry) =>
        expressionAst(entry, constants, resolving),
      ),
    };
  }
  if (ts.isObjectLiteralExpression(current)) {
    const fields = {};
    for (const property of current.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (Object.hasOwn(fields, name)) {
          throw new Error(`Duplicate Convex contract object field: ${name}`);
        }
        fields[name] = expressionAst(
          property.initializer,
          constants,
          resolving,
        );
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const name = property.name.text;
        if (Object.hasOwn(fields, name)) {
          throw new Error(`Duplicate Convex contract object field: ${name}`);
        }
        fields[name] = expressionAst(property.name, constants, resolving);
      } else {
        throw new Error(
          "Convex contract object contains an unsupported member",
        );
      }
    }
    return { kind: "object", fields };
  }
  throw new Error("Unsupported Convex contract expression");
}

function literalString(node, constants, name) {
  const value = expressionAst(node, constants);
  if (value.kind !== "string")
    throw new Error(`${name} is not a string literal`);
  return value.value;
}

function stringArray(node, constants, name) {
  const value = expressionAst(node, constants);
  if (
    value.kind !== "array" ||
    value.values.some((entry) => entry.kind !== "string")
  ) {
    throw new Error(`${name} must be an array of string literals`);
  }
  return value.values.map((entry) => entry.value);
}

function objectValidator(node, constants, resolving = new Set()) {
  const current = resolveConstant(node, constants, resolving);
  if (!ts.isObjectLiteralExpression(current)) {
    throw new Error("Convex validator object must be an object literal");
  }
  const fields = {};
  for (const property of current.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("Convex validator object contains an unsupported member");
    }
    const name = propertyName(property.name);
    if (Object.hasOwn(fields, name)) {
      throw new Error(`Duplicate Convex validator field: ${name}`);
    }
    fields[name] = validator(property.initializer, constants, resolving);
  }
  return { type: "object", fields };
}

function validator(node, constants, resolving = new Set()) {
  const original = unwrap(node);
  if (ts.isIdentifier(original)) {
    const value = constants.get(original.text);
    if (value === undefined) {
      throw new Error(`Unresolved Convex validator: ${original.text}`);
    }
    if (value.knownValidator !== undefined) {
      return structuredClone(value.knownValidator);
    }
    if (resolving.has(original.text)) {
      throw new Error(`Recursive Convex validator: ${original.text}`);
    }
    return validator(value, constants, new Set([...resolving, original.text]));
  }
  if (ts.isObjectLiteralExpression(original)) {
    return objectValidator(original, constants, resolving);
  }
  if (
    !ts.isCallExpression(original) ||
    !ts.isPropertyAccessExpression(original.expression) ||
    !ts.isIdentifier(original.expression.expression) ||
    original.expression.expression.text !== "v"
  ) {
    throw new Error("Unsupported Convex validator expression");
  }
  const kind = original.expression.name.text;
  if (
    [
      "string",
      "number",
      "float64",
      "int64",
      "boolean",
      "bytes",
      "any",
      "null",
    ].includes(kind)
  ) {
    if (original.arguments.length !== 0) {
      throw new Error(`v.${kind} validator has unexpected arguments`);
    }
    return { type: kind };
  }
  if (kind === "id") {
    if (original.arguments.length !== 1)
      throw new Error("v.id arity is invalid");
    return {
      type: "id",
      table: literalString(original.arguments[0], constants, "v.id table"),
    };
  }
  if (kind === "literal") {
    if (original.arguments.length !== 1) {
      throw new Error("v.literal arity is invalid");
    }
    const value = literalAst(
      resolveConstant(original.arguments[0], constants, resolving),
    );
    if (value === undefined) throw new Error("v.literal value is not literal");
    return { type: "literal", value };
  }
  if (["optional", "array"].includes(kind)) {
    if (original.arguments.length !== 1) {
      throw new Error(`v.${kind} arity is invalid`);
    }
    return {
      type: kind,
      value: validator(original.arguments[0], constants, resolving),
    };
  }
  if (kind === "object") {
    if (original.arguments.length !== 1) {
      throw new Error("v.object arity is invalid");
    }
    return objectValidator(original.arguments[0], constants, resolving);
  }
  if (kind === "union") {
    if (original.arguments.length === 0)
      throw new Error("v.union cannot be empty");
    return {
      type: "union",
      values: original.arguments
        .map((argument) => validator(argument, constants, resolving))
        .sort((left, right) =>
          JSON.stringify(canonical(left)).localeCompare(
            JSON.stringify(canonical(right)),
          ),
        ),
    };
  }
  if (kind === "record") {
    if (original.arguments.length !== 2) {
      throw new Error("v.record arity is invalid");
    }
    return {
      type: "record",
      keys: validator(original.arguments[0], constants, resolving),
      values: validator(original.arguments[1], constants, resolving),
    };
  }
  throw new Error(`Unsupported Convex validator v.${kind}`);
}

function accepts(candidate, base) {
  if (equal(candidate, base) || candidate.type === "any") return true;
  if (
    NUMBER_VALIDATORS.has(candidate.type) &&
    NUMBER_VALIDATORS.has(base.type)
  ) {
    return true;
  }
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
    if (base.value.kind === "string" && candidate.type === "string")
      return true;
    if (base.value.kind === "number" && NUMBER_VALIDATORS.has(candidate.type)) {
      return true;
    }
    if (base.value.kind === "bigint" && candidate.type === "int64") return true;
    if (base.value.kind === "boolean" && candidate.type === "boolean")
      return true;
    if (base.value.kind === "null" && candidate.type === "null") return true;
  }
  if (candidate.type === "array" && base.type === "array") {
    return accepts(candidate.value, base.value);
  }
  if (candidate.type === "record" && base.type === "record") {
    return (
      accepts(candidate.keys, base.keys) &&
      accepts(candidate.values, base.values)
    );
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
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        const identity = `${statement.moduleSpecifier.text}:${imported}`;
        const knownValidator = KNOWN_VALIDATOR_IMPORTS.get(identity);
        if (knownValidator !== undefined) {
          constants.set(element.name.text, { knownValidator });
        }
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return constants;
}

function objectProperty(node, name, constants) {
  const current = resolveConstant(node, constants, new Set());
  if (!ts.isObjectLiteralExpression(current)) return undefined;
  const seen = new Set();
  for (const property of current.properties) {
    if (
      !ts.isShorthandPropertyAssignment(property) &&
      !ts.isPropertyAssignment(property)
    ) {
      throw new Error("Convex contract object contains an unsupported member");
    }
    const currentName = propertyName(property.name);
    if (seen.has(currentName)) {
      throw new Error(`Duplicate Convex contract property: ${currentName}`);
    }
    seen.add(currentName);
  }
  for (const property of current.properties) {
    const currentName = propertyName(property.name);
    if (ts.isShorthandPropertyAssignment(property) && currentName === name) {
      return property.name;
    }
    if (ts.isPropertyAssignment(property) && currentName === name) {
      return property.initializer;
    }
  }
  return undefined;
}

function indexDefinition(method, args, constants) {
  if (args.length !== 2) throw new Error(`Convex ${method} arity is invalid`);
  const name = literalString(args[0], constants, "Convex index name");
  if (method === "index") {
    return {
      method,
      name,
      fields: stringArray(args[1], constants, `Convex index ${name} fields`),
    };
  }
  const config = expressionAst(args[1], constants);
  if (config.kind !== "object") {
    throw new Error(
      `Convex ${method} ${name} config must be an object literal`,
    );
  }
  const fieldName = method === "searchIndex" ? "searchField" : "vectorField";
  if (config.fields[fieldName]?.kind !== "string") {
    throw new Error(`Convex ${method} ${name} ${fieldName} is not literal`);
  }
  if (
    config.fields.filterFields !== undefined &&
    (config.fields.filterFields.kind !== "array" ||
      config.fields.filterFields.values.some(
        (entry) => entry.kind !== "string",
      ))
  ) {
    throw new Error(`Convex ${method} ${name} filterFields are not literal`);
  }
  if (
    method === "vectorIndex" &&
    (config.fields.dimensions?.kind !== "number" ||
      !Number.isSafeInteger(config.fields.dimensions.value) ||
      config.fields.dimensions.value <= 0)
  ) {
    throw new Error(`Convex vectorIndex ${name} dimensions are invalid`);
  }
  return { method, name, config };
}

function tableDefinition(node, constants) {
  const indexes = [];
  let current = resolveConstant(node, constants, new Set());
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    const method = current.expression.name.text;
    if (!INDEX_METHODS.has(method)) {
      throw new Error(`Unsupported Convex table method: ${method}`);
    }
    indexes.push(indexDefinition(method, [...current.arguments], constants));
    current = unwrap(current.expression.expression);
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
    exportDefault.expression.arguments.length !== 1
  ) {
    throw new Error("convex/schema.ts must export defineSchema object literal");
  }
  const schema = resolveConstant(
    exportDefault.expression.arguments[0],
    constants,
    new Set(),
  );
  if (!ts.isObjectLiteralExpression(schema)) {
    throw new Error("convex/schema.ts must export defineSchema object literal");
  }
  const tables = {};
  for (const property of schema.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("Convex schema contains unsupported table syntax");
    }
    const name = propertyName(property.name);
    if (Object.hasOwn(tables, name))
      throw new Error(`Duplicate Convex table: ${name}`);
    tables[name] = tableDefinition(property.initializer, constants);
  }
  return tables;
}

function exported(statement) {
  return statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function exportedBindings(source) {
  const bindings = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          bindings.set(declaration.name.text, declaration.name.text);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        bindings.set(
          element.propertyName?.text ?? element.name.text,
          element.name.text,
        );
      }
    }
  }
  return bindings;
}

function registrationAliases(source) {
  const aliases = new Map([...FUNCTION_KINDS].map((kind) => [kind, kind]));
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (FUNCTION_KINDS.has(imported))
        aliases.set(element.name.text, imported);
    }
  }
  return aliases;
}

function functionInventory(path, source, constants) {
  const functions = {};
  const exports = exportedBindings(source);
  const aliases = registrationAliases(source);

  function addFunction(exportedName, initializer) {
    if (
      !ts.isCallExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      !aliases.has(initializer.expression.text) ||
      initializer.arguments.length !== 1
    ) {
      return;
    }
    const definition = initializer.arguments[0];
    const args = objectProperty(definition, "args", constants);
    if (args === undefined) {
      throw new Error(`Convex function ${path}:${exportedName} has no args`);
    }
    const argsValidator = validator(args, constants);
    if (argsValidator.type !== "object") {
      throw new Error(
        `Convex function ${path}:${exportedName} args are not an object`,
      );
    }
    const returns = objectProperty(definition, "returns", constants);
    const identity = `${path.slice("convex/".length, -3)}:${exportedName}`;
    if (Object.hasOwn(functions, identity)) {
      throw new Error(`Duplicate Convex function: ${identity}`);
    }
    functions[identity] = {
      kind: aliases.get(initializer.expression.text),
      args: argsValidator,
      returns: returns === undefined ? null : validator(returns, constants),
    };
  }

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
        continue;
      const exportedName = exports.get(declaration.name.text);
      const initializer = resolveConstant(
        declaration.initializer,
        constants,
        new Set(),
      );
      if (exportedName !== undefined) addFunction(exportedName, initializer);
    }
  }
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      addFunction(
        "default",
        resolveConstant(statement.expression, constants, new Set()),
      );
    }
  }
  return functions;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function httpInventory(source, constants) {
  const routes = {};
  const routers = new Set();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer =
        declaration.initializer && unwrap(declaration.initializer);
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "httpRouter"
      ) {
        routers.add(declaration.name.text);
      }
    }
  }
  if (routers.size === 0)
    throw new Error("Convex HTTP router declaration is missing");
  const exportDefault = source.statements.find(ts.isExportAssignment);
  const exportedRouter = exportDefault && unwrap(exportDefault.expression);
  if (
    !exportedRouter ||
    !ts.isIdentifier(exportedRouter) ||
    !routers.has(exportedRouter.text)
  ) {
    throw new Error("Convex HTTP default export is not an inventoried router");
  }

  function addRoute(registration, method, path) {
    const identity = `${method}:${path}`;
    const value = { registration, method, path };
    if (Object.hasOwn(routes, identity) && !equal(routes[identity], value)) {
      throw new Error(`Duplicate Convex HTTP route: ${identity}`);
    }
    routes[identity] = value;
  }

  const factories = new Map();
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      routers.has(node.expression.expression.text) &&
      ["route", "routePrefix"].includes(node.expression.name.text) &&
      node.arguments.length === 1
    ) {
      const registration = node.expression.name.text;
      const pathKey = registration === "route" ? "path" : "pathPrefix";
      const pathNode = objectProperty(node.arguments[0], pathKey, constants);
      const methodNode = objectProperty(node.arguments[0], "method", constants);
      if (pathNode === undefined || methodNode === undefined) {
        throw new Error(`Convex HTTP ${registration} identity is incomplete`);
      }
      const method = literalString(methodNode, constants, "Convex HTTP method");
      const owner = enclosingFunction(node);
      if (owner === undefined) {
        addRoute(
          registration,
          method,
          literalString(pathNode, constants, `Convex HTTP ${pathKey}`),
        );
      } else if (ts.isFunctionDeclaration(owner) && owner.name) {
        const path = unwrap(pathNode);
        if (!ts.isIdentifier(path)) {
          throw new Error("Convex HTTP route factory path must be a parameter");
        }
        const parameterIndex = owner.parameters.findIndex(
          (parameter) =>
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === path.text,
        );
        if (parameterIndex < 0) {
          throw new Error("Convex HTTP route factory path is not a parameter");
        }
        const entries = factories.get(owner.name.text) ?? [];
        entries.push({ registration, method, parameterIndex });
        factories.set(owner.name.text, entries);
      } else {
        throw new Error("Unsupported Convex HTTP route factory");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  function visitFactoryCalls(node) {
    const expression = ts.isCallExpression(node) && unwrap(node.expression);
    if (expression && ts.isIdentifier(expression)) {
      const descriptors = factories.get(expression.text);
      if (descriptors !== undefined) {
        for (const descriptor of descriptors) {
          const argument = node.arguments[descriptor.parameterIndex];
          if (argument === undefined) {
            throw new Error(
              "Convex HTTP route factory call has no path argument",
            );
          }
          addRoute(
            descriptor.registration,
            descriptor.method,
            literalString(argument, constants, "Convex HTTP factory path"),
          );
        }
      }
    }
    ts.forEachChild(node, visitFactoryCalls);
  }
  visitFactoryCalls(source);
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
      Object.assign(inventory.routes, httpInventory(source, constants));
    }
  }
  if (Object.keys(inventory.tables).length === 0) {
    throw new Error("Convex contract has no schema tables");
  }
  return canonical(inventory);
}

export function classifyConvexContract(baseSha, candidateSha) {
  if (!SHA_RE.test(baseSha ?? "") || !SHA_RE.test(candidateSha ?? "")) {
    throw new Error("Exact Convex contract base and target SHAs are required");
  }
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
    const candidateIndexes = new Map(
      next.indexes.map((index) => [`${index.method}:${index.name}`, index]),
    );
    for (const index of table.indexes) {
      const identity = `${index.method}:${index.name}`;
      const candidateIndex = candidateIndexes.get(identity);
      if (candidateIndex === undefined) {
        reasons.push(`index removed: ${name}.${index.name}`);
      } else if (!equal(candidateIndex, index)) {
        reasons.push(`index definition changed: ${name}.${index.name}`);
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
    if (!accepts(next.args, fn.args)) {
      reasons.push(`function args narrowed: ${name}`);
    }
    if (!equal(next.returns, fn.returns)) {
      reasons.push(`function return validator changed: ${name}`);
    }
  }
  for (const [identity, route] of Object.entries(base.routes)) {
    const next = candidate.routes[identity];
    if (next === undefined) {
      reasons.push(`HTTP route removed: ${identity}`);
    } else if (!equal(next, route)) {
      reasons.push(`HTTP route changed: ${identity}`);
    }
  }
  return {
    baseSha,
    candidateSha,
    baseDigest: digest(base),
    candidateDigest: digest(candidate),
    hasChange: !equal(base, candidate),
    hasContraction: reasons.length > 0,
    reasons: reasons.sort(),
  };
}

function parseArgs(argv) {
  const [command, ...raw] = argv;
  const args = {};
  for (const entry of raw) {
    if (!entry.startsWith("--") || !entry.includes("=")) {
      throw new Error(`Invalid argument: ${entry}`);
    }
    const [name, ...value] = entry.slice(2).split("=");
    if (Object.hasOwn(args, name))
      throw new Error(`Duplicate argument: ${name}`);
    args[name] = value.join("=");
  }
  return { command, args };
}

export function run(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv);
  if (command === "inventory") {
    const inventory = convexContractAt(args.sha);
    process.stdout.write(`${JSON.stringify(inventory)}\n`);
    return inventory;
  }
  if (command === "classify") {
    const classification = classifyConvexContract(args.base, args.target);
    process.stdout.write(`${JSON.stringify(classification)}\n`);
    return classification;
  }
  throw new Error(
    "Usage: release-convex-contract.mjs inventory --sha=<sha> | classify --base=<sha> --target=<sha>",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    run();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Convex contract check failed",
    );
    process.exitCode = 1;
  }
}
