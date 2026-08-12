import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
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
const SOURCE_EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/;
const MUTATING_METHODS = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
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

function isAncestor(base, target) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, target], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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
        SOURCE_EXTENSION_RE.test(path) &&
        !path.endsWith(".d.ts") &&
        !/^convex\/_generated\//.test(path) &&
        !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(path) &&
        !/\.config\.(?:[cm]?[jt]sx?)$/.test(path),
    )
    .sort();
}

function generatedRegistrarsAt(sha) {
  const output = git(["ls-tree", "-r", "--name-only", sha, "--", "convex"]);
  const registrars = Object.fromEntries(
    output
      .split("\n")
      .filter((path) => /(^|\/)\_generated\/server\.(?:[cm]?[jt]s)$/.test(path))
      .sort()
      .map((path) => [path, digest(sourceAt(sha, path))]),
  );
  if (Object.keys(registrars).length === 0) {
    throw new Error("Convex generated server registrar is missing");
  }
  return registrars;
}

function moduleIdentity(path) {
  return path.slice("convex/".length).replace(SOURCE_EXTENSION_RE, "");
}

function scriptKind(path) {
  if (/\.[cm]?jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function parseSource(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse Convex contract source ${path}`);
  }
  return source;
}

function rootIdentifier(node) {
  let current = unwrap(node);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function containsIdentifier(node, names) {
  let found = false;
  function visit(current) {
    if (ts.isIdentifier(current) && names.has(current.text)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function containsEscapingValue(node, names) {
  const current = unwrap(node);
  if (
    ts.isArrowFunction(current) ||
    ts.isFunctionExpression(current) ||
    ts.isFunctionDeclaration(current)
  ) {
    return false;
  }
  if (names.has(rootIdentifier(current))) return true;
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.some((entry) =>
      containsEscapingValue(entry, names),
    );
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return containsEscapingValue(property.initializer, names);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return names.has(property.name.text);
      }
      if (ts.isSpreadAssignment(property)) {
        return containsEscapingValue(property.expression, names);
      }
      return false;
    });
  }
  if (ts.isSpreadElement(current)) {
    return containsEscapingValue(current.expression, names);
  }
  if (ts.isConditionalExpression(current)) {
    return (
      containsEscapingValue(current.whenTrue, names) ||
      containsEscapingValue(current.whenFalse, names)
    );
  }
  return false;
}

function isTopLevelExpression(node) {
  return node.parent !== undefined &&
    ts.isExpressionStatement(node.parent) &&
    node.parent.parent !== undefined &&
    ts.isSourceFile(node.parent.parent);
}

function isStaticRouterRegistration(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    return ["route", "routePrefix"].includes(expression.name.text);
  }
  if (!ts.isElementAccessExpression(expression)) return false;
  const literal = expression.argumentExpression
    ? literalAst(expression.argumentExpression)
    : undefined;
  return literal?.kind === "string" &&
    ["route", "routePrefix"].includes(literal.value);
}

function assertStaticTopLevelContract(source, allowRouterRegistrations = false) {
  const topLevel = new Set();
  const declarations = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) {
      throw new Error(
        "Convex contract source contains mutable top-level declaration",
      );
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        topLevel.add(declaration.name.text);
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const primitiveTopLevel = new Set();
  let learned = true;
  while (learned) {
    learned = false;
    for (const [name, initializer] of declarations) {
      if (primitiveTopLevel.has(name) || initializer === undefined) continue;
      const current = unwrap(initializer);
      if (
        literalAst(current) !== undefined ||
        (ts.isIdentifier(current) && primitiveTopLevel.has(current.text))
      ) {
        primitiveTopLevel.add(name);
        learned = true;
      }
    }
  }
  const mutableTopLevel = new Set(
    [...topLevel].filter((name) => !primitiveTopLevel.has(name)),
  );

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (topLevel.has(rootIdentifier(node.left)) ||
        containsIdentifier(node.left, topLevel) ||
        ["exports", "module"].includes(rootIdentifier(node.left)))
    ) {
      throw new Error("Convex contract top-level constant is reassigned");
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        node.operator,
      ) &&
      topLevel.has(rootIdentifier(node.operand))
    ) {
      throw new Error("Convex contract top-level constant is updated");
    }
    if (
      ts.isDeleteExpression(node) &&
      topLevel.has(rootIdentifier(node.expression))
    ) {
      throw new Error("Convex contract top-level constant is deleted");
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Object" &&
        [
          "assign",
          "defineProperty",
          "defineProperties",
          "setPrototypeOf",
        ].includes(expression.name.text)
      ) {
        throw new Error("Convex contract uses runtime object mutation");
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Reflect" &&
        ["set", "deleteProperty", "defineProperty", "setPrototypeOf"].includes(
          expression.name.text,
        )
      ) {
        throw new Error("Convex contract uses runtime reflection mutation");
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        MUTATING_METHODS.has(expression.name.text) &&
        mutableTopLevel.has(rootIdentifier(expression.expression))
      ) {
        throw new Error("Convex contract top-level constant is mutated");
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        ["call", "apply"].includes(expression.name.text) &&
        node.arguments.some((argument) =>
          containsEscapingValue(argument, mutableTopLevel),
        )
      ) {
        throw new Error(
          "Convex contract top-level constant escapes through call",
        );
      }
      if (
        ts.isExpressionStatement(node.parent) &&
        node.arguments.some((argument) =>
          containsEscapingValue(argument, mutableTopLevel),
        ) &&
        !(
          ts.isPropertyAccessExpression(expression) &&
          ["route", "routePrefix"].includes(expression.name.text)
        )
      ) {
        throw new Error(
          `Convex contract top-level constant escapes to side effect at ${source.fileName}: ${node.getText(source)}`,
        );
      }
      if (
        isTopLevelExpression(node) &&
        (!allowRouterRegistrations || !isStaticRouterRegistration(node))
      ) {
        throw new Error(
          `Convex contract contains top-level side effect at ${source.fileName}: ${node.getText(source)}`,
        );
      }
    } else if (isTopLevelExpression(node)) {
      throw new Error(
        `Convex contract contains top-level side effect at ${source.fileName}: ${node.getText(source)}`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function resolveRelativeModuleFromSources(path, specifier, sourcePaths) {
  if (!specifier.startsWith(".")) return undefined;
  const candidate = posix
    .normalize(posix.join(posix.dirname(path), specifier))
    .replace(SOURCE_EXTENSION_RE, "");
  const matches = sourcePaths.filter(
    (entry) =>
      entry.replace(SOURCE_EXTENSION_RE, "") === candidate ||
      entry.replace(SOURCE_EXTENSION_RE, "").replace(/\/index$/, "") === candidate,
  );
  if (matches.length > 1) {
    throw new Error(`Ambiguous Convex dependency: ${path} -> ${specifier}`);
  }
  return matches[0];
}

function exportedValues(path, sources, cache, stack = new Set()) {
  if (cache.has(path)) return cache.get(path);
  if (stack.has(path)) throw new Error(`Recursive Convex dependency: ${path}`);
  const source = sources.get(path);
  if (source === undefined) throw new Error(`Missing Convex dependency source: ${path}`);
  const values = new Map();
  const locals = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          locals.set(declaration.name.text, declaration.initializer);
          if (exported(statement)) values.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      values.set("default", statement.expression);
    }
    if (ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier === undefined &&
        statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        const value = locals.get(local);
        if (value === undefined) throw new Error(`Unresolved Convex export: ${path}:${local}`);
        values.set(element.name.text, value);
      }
    }
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const targetPath = resolveRelativeModuleFromSources(
      path,
      statement.moduleSpecifier.text,
      [...sources.keys()],
    );
    if (targetPath === undefined) {
      throw new Error(`Unresolved Convex dependency: ${path} -> ${statement.moduleSpecifier.text}`);
    }
    const target = exportedValues(targetPath, sources, cache, new Set([...stack, path]));
    if (statement.exportClause === undefined) {
      for (const [name, value] of target) {
        if (name !== "default") values.set(name, value);
      }
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        const value = target.get(imported);
        if (value === undefined) {
          throw new Error(`Unresolved Convex re-export: ${path}:${imported}`);
        }
        values.set(element.name.text, value);
      }
    } else {
      throw new Error(`Unsupported Convex namespace re-export: ${path}`);
    }
  }
  cache.set(path, values);
  return values;
}

function constantsIn(source, path, sources, exportCache = new Map()) {
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
        } else if (statement.moduleSpecifier.text.startsWith(".")) {
          const generatedTarget = posix
            .normalize(
              posix.join(posix.dirname(path), statement.moduleSpecifier.text),
            )
            .replace(SOURCE_EXTENSION_RE, "");
          if (generatedTarget.endsWith("/_generated/server")) continue;
          const targetPath = resolveRelativeModuleFromSources(
            path,
            statement.moduleSpecifier.text,
            [...sources.keys()],
          );
          if (targetPath === undefined) {
            throw new Error(`Unresolved Convex dependency: ${path} -> ${statement.moduleSpecifier.text}`);
          }
          const value = exportedValues(targetPath, sources, exportCache).get(imported);
          if (value === undefined) {
            throw new Error(`Unresolved Convex import: ${path}:${imported}`);
          }
          constants.set(element.name.text, value);
        }
      }
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.name &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      const targetPath = resolveRelativeModuleFromSources(
        path,
        statement.moduleSpecifier.text,
        [...sources.keys()],
      );
      if (targetPath === undefined) {
        throw new Error(`Unresolved Convex dependency: ${path}`);
      }
      const value = exportedValues(targetPath, sources, exportCache).get("default");
      if (value === undefined) {
        throw new Error(`Unresolved Convex default import: ${path}`);
      }
      constants.set(statement.importClause.name.text, value);
    }
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
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
  function add(localName, exportedName) {
    const names = bindings.get(localName) ?? new Set();
    names.add(exportedName);
    bindings.set(localName, names);
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          add(declaration.name.text, declaration.name.text);
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
        add(element.propertyName?.text ?? element.name.text, element.name.text);
      }
    }
  }
  return bindings;
}

function registrationAliases(path, source) {
  const aliases = new Map();
  const namespaces = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const resolved = specifier.startsWith(".")
      ? posix
          .normalize(posix.join(posix.dirname(path), specifier))
          .replace(SOURCE_EXTENSION_RE, "")
      : undefined;
    if (resolved !== "convex/_generated/server") continue;
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaces.set(
        statement.importClause.namedBindings.name.text,
        new Set(FUNCTION_KINDS),
      );
      continue;
    }
    if (ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (FUNCTION_KINDS.has(imported)) {
          aliases.set(element.name.text, imported);
        }
      }
    }
  }
  return { aliases, namespaces };
}

function functionInventory(path, source, constants) {
  const functions = {};
  const exports = exportedBindings(source);
  const { aliases, namespaces } = registrationAliases(path, source);

  function registrarKind(expression) {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text);
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression)
    ) {
      return namespaces.get(expression.expression.text)?.has(expression.name.text)
        ? expression.name.text
        : undefined;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression)
    ) {
      const literal = expression.argumentExpression
        ? literalAst(expression.argumentExpression)
        : undefined;
      if (literal?.kind !== "string") {
        throw new Error("Computed Convex function registration is unsupported");
      }
      return namespaces.get(expression.expression.text)?.has(literal.value)
        ? literal.value
        : undefined;
    }
    return undefined;
  }

  function rejectUnsupportedRegistrations(node) {
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if (
        (ts.isElementAccessExpression(expression) ||
          ts.isPropertyAccessExpression(expression)) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text)
      ) {
        if (registrarKind(expression) === undefined) {
          throw new Error("Unsupported computed Convex function registration");
        }
      }
    }
    ts.forEachChild(node, rejectUnsupportedRegistrations);
  }
  rejectUnsupportedRegistrations(source);

  function addFunction(exportedName, initializer) {
    if (
      !ts.isCallExpression(initializer) ||
      registrarKind(initializer.expression) === undefined ||
      initializer.arguments.length !== 1
    ) {
      if (
        ts.isCallExpression(initializer) &&
        initializer.arguments.length === 1 &&
        objectProperty(initializer.arguments[0], "args", constants) !==
          undefined &&
        objectProperty(initializer.arguments[0], "handler", constants) !==
          undefined
      ) {
        throw new Error(
          `Unsupported Convex function registrar at ${path}:${exportedName}`,
        );
      }
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
    const handler = objectProperty(definition, "handler", constants);
    if (handler === undefined) {
      throw new Error(`Convex function ${path}:${exportedName} has no handler`);
    }
    const identity = `${moduleIdentity(path)}:${exportedName}`;
    if (Object.hasOwn(functions, identity)) {
      throw new Error(`Duplicate Convex function: ${identity}`);
    }
    functions[identity] = {
      kind: registrarKind(initializer.expression),
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
      if (exportedName !== undefined) {
        for (const name of exportedName) addFunction(name, initializer);
      }
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

function resolveRelativeModule(path, specifier, sourcePaths) {
  if (!specifier.startsWith(".")) return undefined;
  const candidate = posix
    .normalize(posix.join(posix.dirname(path), specifier))
    .replace(SOURCE_EXTENSION_RE, "");
  const matches = sourcePaths.filter(
    (entry) =>
      entry.replace(SOURCE_EXTENSION_RE, "") === candidate ||
      entry.replace(SOURCE_EXTENSION_RE, "").replace(/\/index$/, "") ===
        candidate,
  );
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Convex re-export module: ${path} -> ${specifier}`,
    );
  }
  return matches[0];
}

function addReexportedFunctions(inventory, sources) {
  const paths = [...sources.keys()];
  const direct = new Map();
  for (const path of paths) {
    const prefix = `${moduleIdentity(path)}:`;
    direct.set(
      path,
      new Map(
        Object.entries(inventory)
          .filter(([identity]) => identity.startsWith(prefix))
          .map(([identity, value]) => [identity.slice(prefix.length), value]),
      ),
    );
  }
  const resolved = new Map();
  function add(result, name, value, path) {
    if (result.has(name)) {
      throw new Error(`Duplicate Convex function export: ${path}:${name}`);
    }
    result.set(name, value);
  }
  function exportsFor(path, stack = new Set()) {
    if (resolved.has(path)) return resolved.get(path);
    if (stack.has(path)) throw new Error(`Recursive Convex re-export: ${path}`);
    const result = new Map(direct.get(path));
    const source = sources.get(path);
    for (const statement of source.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const targetPath = resolveRelativeModule(
        path,
        statement.moduleSpecifier.text,
        paths,
      );
      if (targetPath === undefined) continue;
      const target = exportsFor(targetPath, new Set([...stack, path]));
      if (statement.exportClause === undefined) {
        for (const [name, value] of target) {
          if (name !== "default") add(result, name, value, path);
        }
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) {
        if (target.size > 0) {
          throw new Error("Unsupported namespace Convex function re-export");
        }
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const value = target.get(importedName);
        if (value !== undefined) add(result, element.name.text, value, path);
      }
    }
    resolved.set(path, result);
    return result;
  }
  for (const path of paths) {
    for (const [name, value] of exportsFor(path)) {
      inventory[`${moduleIdentity(path)}:${name}`] = value;
    }
  }
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

function httpInventory(path, source, constants) {
  const routes = {};
  const routers = new Set();
  const routerFactories = new Set();
  const importBindings = new Map();
  const functionBindings = new Map();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause.name) {
        importBindings.set(statement.importClause.name.text, {
          imported: "default",
          module: specifier,
        });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          importBindings.set(element.name.text, {
            imported,
            module: specifier,
          });
          if (specifier === "convex/server" && imported === "httpRouter") {
            routerFactories.add(element.name.text);
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        importBindings.set(bindings.name.text, {
          imported: "*",
          module: specifier,
        });
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functionBindings.set(statement.name.text, statement.getText(source));
    }
  }

  function resolvesTo(name, accepted, seen = new Set()) {
    if (accepted.has(name)) return name;
    if (seen.has(name)) return undefined;
    const value = constants.get(name);
    const current =
      value && value.knownValidator === undefined ? unwrap(value) : undefined;
    if (!current || !ts.isIdentifier(current)) return undefined;
    return resolvesTo(current.text, accepted, new Set([...seen, name]));
  }
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
        resolvesTo(initializer.expression.text, routerFactories) !==
          undefined &&
        initializer.arguments.length === 0
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
    resolvesTo(exportedRouter.text, routers) === undefined
  ) {
    throw new Error("Convex HTTP default export is not an inventoried router");
  }

  function addRoute(registration, method, routePath, handlerDigest) {
    const identity = `${method}:${routePath}`;
    const value = { registration, method, path: routePath, handlerDigest };
    if (Object.hasOwn(routes, identity) && !equal(routes[identity], value)) {
      throw new Error(`Duplicate Convex HTTP route: ${identity}`);
    }
    routes[identity] = value;
  }

  const factories = new Map();
  function handlerBinding(node, seen = new Set()) {
    const current = unwrap(node);
    if (ts.isIdentifier(current)) {
      if (seen.has(current.text)) {
        throw new Error("Recursive Convex HTTP handler binding");
      }
      const value = constants.get(current.text);
      if (value && value.knownValidator === undefined) {
        return handlerBinding(value, new Set([...seen, current.text]));
      }
      if (importBindings.has(current.text)) {
        return { import: importBindings.get(current.text) };
      }
      if (functionBindings.has(current.text)) {
        return { declaration: functionBindings.get(current.text) };
      }
      return { identifier: current.text };
    }
    return { syntax: current.getText(source) };
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      const routerRoot =
        (ts.isPropertyAccessExpression(expression) ||
          ts.isElementAccessExpression(expression)) &&
        ts.isIdentifier(expression.expression) &&
        resolvesTo(expression.expression.text, routers) !== undefined;
      const registration = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression) && expression.argumentExpression
          ? literalAst(expression.argumentExpression)?.value
          : undefined;
      const routeLike =
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression);
      if (routeLike && !routerRoot) {
        if (["route", "routePrefix"].includes(registration)) {
          throw new Error("Convex HTTP registration uses untracked router");
        }
      }
      if (routerRoot && !["route", "routePrefix"].includes(registration)) {
        throw new Error(
          "Computed Convex HTTP router registration is unsupported",
        );
      }
      if (routerRoot) {
        if (node.arguments.length !== 1) {
          throw new Error("Convex HTTP registration arity is invalid");
        }
        const pathKey = registration === "route" ? "path" : "pathPrefix";
        const pathNode = objectProperty(node.arguments[0], pathKey, constants);
        const methodNode = objectProperty(
          node.arguments[0],
          "method",
          constants,
        );
        const handlerNode = objectProperty(
          node.arguments[0],
          "handler",
          constants,
        );
        if (
          pathNode === undefined ||
          methodNode === undefined ||
          handlerNode === undefined
        ) {
          throw new Error(`Convex HTTP ${registration} identity is incomplete`);
        }
        const method = literalString(
          methodNode,
          constants,
          "Convex HTTP method",
        );
        const handlerDigest = digest(handlerBinding(handlerNode));
        const owner = enclosingFunction(node);
        if (owner === undefined) {
          addRoute(
            registration,
            method,
            literalString(pathNode, constants, `Convex HTTP ${pathKey}`),
            handlerDigest,
          );
        } else if (ts.isFunctionDeclaration(owner) && owner.name) {
          const path = unwrap(pathNode);
          if (!ts.isIdentifier(path)) {
            throw new Error(
              "Convex HTTP route factory path must be a parameter",
            );
          }
          const parameterIndex = owner.parameters.findIndex(
            (parameter) =>
              ts.isIdentifier(parameter.name) &&
              parameter.name.text === path.text,
          );
          if (parameterIndex < 0) {
            throw new Error(
              "Convex HTTP route factory path is not a parameter",
            );
          }
          const entries = factories.get(owner.name.text) ?? [];
          entries.push({ registration, method, parameterIndex, handlerDigest });
          factories.set(owner.name.text, entries);
        } else {
          throw new Error("Unsupported Convex HTTP route factory");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  function visitFactoryCalls(node) {
    const expression = ts.isCallExpression(node) && unwrap(node.expression);
    if (expression && ts.isIdentifier(expression)) {
      const factoryName = resolvesTo(
        expression.text,
        new Set(factories.keys()),
      );
      const descriptors = factoryName && factories.get(factoryName);
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
            descriptor.handlerDigest,
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
  const paths = sourceFilesAt(sha);
  const sources = new Map(
    paths.map((path) => [path, parseSource(path, sourceAt(sha, path))]),
  );
  const schemaPaths = paths.filter((path) =>
    /^convex\/schema\.(?:[cm]?[jt]s)$/.test(path),
  );
  const httpPaths = paths.filter((path) =>
    /^convex\/http\.(?:[cm]?[jt]s)$/.test(path),
  );
  if (schemaPaths.length !== 1) {
    throw new Error("Convex schema entrypoint must be unique");
  }
  if (httpPaths.length > 1) {
    throw new Error("Convex HTTP entrypoint must be unique");
  }
  const inventory = {
    registrars: generatedRegistrarsAt(sha),
    tables: {},
    functions: {},
    routes: {},
  };
  const exportCache = new Map();
  for (const [path, source] of sources) {
    assertStaticTopLevelContract(source, path === httpPaths[0]);
    const constants = constantsIn(source, path, sources, exportCache);
    if (path === schemaPaths[0]) {
      inventory.tables = schemaInventory(source, constants);
    }
    Object.assign(
      inventory.functions,
      functionInventory(path, source, constants),
    );
    if (path === httpPaths[0]) {
      Object.assign(inventory.routes, httpInventory(path, source, constants));
    }
  }
  addReexportedFunctions(inventory.functions, sources);
  if (Object.keys(inventory.tables).length === 0) {
    throw new Error("Convex contract has no schema tables");
  }
  return canonical(inventory);
}

export function classifyConvexContract(baseSha, candidateSha) {
  if (!SHA_RE.test(baseSha ?? "") || !SHA_RE.test(candidateSha ?? "")) {
    throw new Error("Exact Convex contract base and target SHAs are required");
  }
  if (!isAncestor(baseSha, candidateSha)) {
    throw new Error("Convex contract base is not an ancestor of target");
  }
  const rows = git([
    "rev-list",
    "--reverse",
    "--parents",
    `${baseSha}..${candidateSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  let expectedParent = baseSha;
  for (const row of rows) {
    const [commit, ...parents] = row.split(" ");
    if (parents.length !== 1 || parents[0] !== expectedParent) {
      throw new Error(
        "Convex contract range must have linear single-parent history",
      );
    }
    expectedParent = commit;
  }
  const base = convexContractAt(baseSha);
  const candidate = convexContractAt(candidateSha);
  const reasons = [];
  if (!equal(base.registrars, candidate.registrars)) {
    reasons.push("generated server registrar changed");
  }
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
