import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EXPORT_STATES = new Set([
  "created",
  "deleted",
  "renamed",
  "transferred",
  "expecting-transfer",
]);
const EXPORT_STORAGE = new Set(["sqlite", "legacy-kv"]);
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WORKER_NAME_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const VERSION_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

function stripJsonComments(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  if (inString || blockComment) throw new Error("Invalid JSONC document");
  return output;
}

function stripTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") continue;
    }
    output += character;
  }
  return output;
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
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

function effectiveConfig(config, environment) {
  if (!environment) return config;
  const selected = config?.env?.[environment];
  if (selected === undefined)
    throw new Error(`Unknown Wrangler env ${environment}`);
  if (
    selected === null ||
    typeof selected !== "object" ||
    Array.isArray(selected)
  ) {
    throw new Error(`Invalid Wrangler env ${environment}`);
  }
  return {
    ...config,
    ...selected,
    // Wrangler bindings are explicitly non-inheritable. Missing named-env
    // configuration means no bindings, even when top-level bindings exist.
    durable_objects: selected.durable_objects ?? { bindings: [] },
    migrations:
      selected.migrations === undefined
        ? config.migrations
        : selected.migrations,
    exports: selected.exports === undefined ? config.exports : selected.exports,
    // Wrangler appends the named environment when name is inherited.
    name:
      selected.name ??
      (typeof config.name === "string"
        ? `${config.name}-${environment}`
        : null),
  };
}

function durableBindings(config) {
  const bindings = config?.durable_objects?.bindings ?? [];
  if (!Array.isArray(bindings))
    throw new Error("Invalid durable_objects.bindings");
  const normalized = bindings.map((binding) => {
    const row = {
      name: binding?.name ?? null,
      className: binding?.class_name ?? null,
      scriptName: binding?.script_name ?? null,
      environment: binding?.environment ?? null,
    };
    if (
      !row.name ||
      !row.className ||
      !IDENTIFIER_RE.test(row.name) ||
      !IDENTIFIER_RE.test(row.className) ||
      (row.scriptName !== null && !WORKER_NAME_RE.test(row.scriptName)) ||
      (row.environment !== null && !WORKER_NAME_RE.test(row.environment)) ||
      (row.environment !== null && row.scriptName === null) ||
      Object.keys(binding ?? {}).some(
        (key) =>
          !["name", "class_name", "script_name", "environment"].includes(key),
      )
    ) {
      throw new Error("Invalid Durable Object binding");
    }
    return row;
  });
  const names = new Set(normalized.map((binding) => binding.name));
  if (names.size !== normalized.length)
    throw new Error("Duplicate DO binding name");
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeMigration(step, tags) {
  if (step === null || typeof step !== "object" || Array.isArray(step)) {
    throw new Error("Invalid Durable Object migration");
  }
  const allowed = new Set([
    "tag",
    "new_classes",
    "new_sqlite_classes",
    "renamed_classes",
    "deleted_classes",
    "transferred_classes",
  ]);
  if (Object.keys(step).some((key) => !allowed.has(key))) {
    throw new Error(
      `Unsupported migration field in ${String(step.tag ?? "untagged")}`,
    );
  }
  if (
    typeof step.tag !== "string" ||
    step.tag.trim() === "" ||
    tags.has(step.tag)
  ) {
    throw new Error("Migration tags must be non-empty and unique");
  }
  tags.add(step.tag);
  const stringArray = (name) => {
    const value = step[name] ?? [];
    if (
      !Array.isArray(value) ||
      value.some((entry) => !IDENTIFIER_RE.test(entry))
    ) {
      throw new Error(`Invalid ${name} in migration ${step.tag}`);
    }
    return [...value].sort();
  };
  const renamed = step.renamed_classes ?? [];
  if (
    !Array.isArray(renamed) ||
    renamed.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        !IDENTIFIER_RE.test(entry.from) ||
        !IDENTIFIER_RE.test(entry.to) ||
        entry.from === entry.to ||
        Object.keys(entry).some((key) => key !== "from" && key !== "to"),
    )
  ) {
    throw new Error(`Invalid renamed_classes in migration ${step.tag}`);
  }
  const transferred = step.transferred_classes ?? [];
  if (
    !Array.isArray(transferred) ||
    transferred.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        !IDENTIFIER_RE.test(entry.from) ||
        !IDENTIFIER_RE.test(entry.to) ||
        !WORKER_NAME_RE.test(entry.from_script) ||
        Object.keys(entry).some(
          (key) => key !== "from" && key !== "from_script" && key !== "to",
        ),
    )
  ) {
    throw new Error(`Invalid transferred_classes in migration ${step.tag}`);
  }
  return {
    tag: step.tag,
    newClasses: stringArray("new_classes"),
    newSqliteClasses: stringArray("new_sqlite_classes"),
    renamedClasses: renamed
      .map(({ from, to }) => ({ from, to }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    transferredClasses: transferred
      .map(({ from, from_script: fromScript, to }) => ({
        from,
        fromScript,
        to,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    deletedClasses: stringArray("deleted_classes"),
  };
}

function normalizeExport(name, value) {
  if (
    !IDENTIFIER_RE.test(name) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`Invalid Durable Object export ${name}`);
  }
  const state = value.state ?? "created";
  if (value.type !== "durable-object" || !EXPORT_STATES.has(state)) {
    throw new Error(`Invalid Durable Object export ${name}`);
  }
  const allowedByState = {
    created: new Set(["type", "state", "storage"]),
    deleted: new Set(["type", "state"]),
    renamed: new Set(["type", "state", "renamed_to"]),
    transferred: new Set(["type", "state", "transferred_to"]),
    "expecting-transfer": new Set([
      "type",
      "state",
      "storage",
      "transfer_from",
    ]),
  };
  if (Object.keys(value).some((key) => !allowedByState[state].has(key))) {
    throw new Error(`Forbidden field on ${state} export ${name}`);
  }
  if (state === "created") {
    if (!EXPORT_STORAGE.has(value.storage))
      throw new Error(`Export ${name} requires storage`);
    return { state, storage: value.storage };
  }
  if (state === "expecting-transfer") {
    if (
      !EXPORT_STORAGE.has(value.storage) ||
      !WORKER_NAME_RE.test(value.transfer_from)
    ) {
      throw new Error(`Export ${name} requires storage and transfer_from`);
    }
    return { state, storage: value.storage, transferFrom: value.transfer_from };
  }
  if (state === "renamed") {
    if (!IDENTIFIER_RE.test(value.renamed_to) || value.renamed_to === name) {
      throw new Error(`Export ${name} requires distinct renamed_to`);
    }
    return { state, renamedTo: value.renamed_to };
  }
  if (state === "transferred") {
    if (!WORKER_NAME_RE.test(value.transferred_to)) {
      throw new Error(`Export ${name} requires transferred_to`);
    }
    return { state, transferredTo: value.transferred_to };
  }
  return { state: "deleted" };
}

function durableExports(config) {
  const exportsConfig = config?.exports ?? {};
  if (
    exportsConfig === null ||
    typeof exportsConfig !== "object" ||
    Array.isArray(exportsConfig)
  ) {
    throw new Error("Invalid exports configuration");
  }
  const entries = [];
  for (const [name, value] of Object.entries(exportsConfig).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      !IDENTIFIER_RE.test(name) ||
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error(`Invalid export ${name}`);
    }
    if (value.type === "durable-object") {
      entries.push([name, normalizeExport(name, value)]);
      continue;
    }
    if (
      value.type !== "worker" ||
      Object.keys(value).some((key) => !["type", "cache"].includes(key)) ||
      (value.cache !== undefined &&
        (value.cache === null ||
          typeof value.cache !== "object" ||
          Array.isArray(value.cache) ||
          typeof value.cache.enabled !== "boolean" ||
          Object.keys(value.cache).some((key) => key !== "enabled")))
    ) {
      throw new Error(`Invalid worker export ${name}`);
    }
  }
  const exports = Object.fromEntries(entries);
  for (const [name, value] of entries) {
    if (value.state === "renamed") {
      const target = exports[value.renamedTo];
      if (!target || target.state !== "created") {
        throw new Error(
          `Renamed export ${name} requires live target ${value.renamedTo}`,
        );
      }
    }
  }
  return exports;
}

export function lifecycleProjection(config, environment) {
  const effective = effectiveConfig(config, environment);
  if (!WORKER_NAME_RE.test(effective?.name)) {
    throw new Error("Wrangler Worker name is missing or invalid");
  }
  const rawMigrations = effective?.migrations ?? [];
  if (!Array.isArray(rawMigrations))
    throw new Error("Invalid migrations array");
  const tags = new Set();
  const migrations = rawMigrations.map((step) =>
    normalizeMigration(step, tags),
  );
  const exports = durableExports(effective);
  if (migrations.length > 0 && Object.keys(exports).length > 0) {
    throw new Error(
      "Legacy migrations and declarative DO exports are mutually exclusive",
    );
  }
  const bindings = durableBindings(effective);
  const mode =
    Object.keys(exports).length > 0
      ? "declarative"
      : migrations.length > 0
        ? "legacy"
        : "none";
  const liveLegacy = mode === "legacy" ? legacyClasses(migrations) : new Map();
  for (const binding of bindings) {
    if (binding.scriptName !== null) continue;
    if (mode === "legacy" && !liveLegacy.has(binding.className)) {
      throw new Error(
        `Local binding ${binding.name} targets undeclared legacy class`,
      );
    }
    if (
      mode === "declarative" &&
      exports[binding.className]?.state !== "created"
    ) {
      throw new Error(
        `Local binding ${binding.name} targets non-live declarative class`,
      );
    }
    if (mode === "none") {
      throw new Error(
        `Local binding ${binding.name} has no lifecycle declaration`,
      );
    }
  }
  return canonical({
    environment: environment ?? null,
    workerName: effective?.name ?? null,
    mode,
    bindings,
    migrations,
    exports,
  });
}

export function lifecycleDigest(config, environment) {
  return createHash("sha256")
    .update(JSON.stringify(lifecycleProjection(config, environment)))
    .digest("hex");
}

function isPrefix(prefix, value) {
  return (
    prefix.length <= value.length &&
    prefix.every((entry, index) => equal(entry, value[index]))
  );
}

function legacyClasses(migrations) {
  const classes = new Map();
  for (const step of migrations) {
    for (const name of step.newClasses) {
      if (classes.has(name))
        throw new Error(`Legacy class ${name} created twice`);
      classes.set(name, "legacy-kv");
    }
    for (const name of step.newSqliteClasses) {
      if (classes.has(name))
        throw new Error(`Legacy class ${name} created twice`);
      classes.set(name, "sqlite");
    }
    for (const { from, to } of step.renamedClasses) {
      const storage = classes.get(from);
      if (!storage || classes.has(to))
        throw new Error(`Invalid legacy rename ${from} -> ${to}`);
      classes.delete(from);
      classes.set(to, storage);
    }
    for (const { to } of step.transferredClasses) {
      if (classes.has(to))
        throw new Error(`Legacy transferred class ${to} already exists`);
      // Legacy transfer metadata omits storage. Keep unknown explicit so a
      // later legacy-to-exports conversion cannot guess and corrupt data.
      classes.set(to, "transferred-unknown");
    }
    for (const name of step.deletedClasses) {
      if (!classes.delete(name))
        throw new Error(`Invalid legacy deletion ${name}`);
    }
  }
  return classes;
}

function bindingChanges(base, candidate, phases, changes) {
  const before = new Map(base.bindings.map((entry) => [entry.name, entry]));
  const after = new Map(candidate.bindings.map((entry) => [entry.name, entry]));
  const coupledClasses = new Set();
  if (candidate.mode === "declarative") {
    for (const [name, value] of Object.entries(candidate.exports)) {
      if (value.state === "renamed") coupledClasses.add(value.renamedTo);
      if (
        value.state === "created" &&
        base.exports[name]?.state === "expecting-transfer"
      ) {
        coupledClasses.add(name);
      }
    }
  }
  for (const [name, binding] of after) {
    const previous = before.get(name);
    if (previous === undefined) {
      if (!(
        binding.scriptName === null && coupledClasses.has(binding.className)
      )) {
        phases.add("expand");
      }
      changes.push(`binding added: ${name}`);
    } else if (!equal(previous, binding)) {
      phases.add("contract");
      changes.push(`binding target changed: ${name}`);
    }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) {
      phases.add("contract");
      changes.push(`binding removed: ${name}`);
    }
  }
}

export function classifyLifecycleChange(
  baseConfig,
  candidateConfig,
  environment,
) {
  const base = lifecycleProjection(baseConfig, environment);
  const candidate = lifecycleProjection(candidateConfig, environment);
  const changes = [];
  const phases = new Set();
  const manualInspectionReasons = [];
  let invalid = false;

  bindingChanges(base, candidate, phases, changes);
  if (base.workerName !== candidate.workerName) {
    invalid = true;
    changes.push("effective Worker identity changed");
  }
  if (base.mode === "declarative" && candidate.mode === "legacy") {
    invalid = true;
    changes.push("declarative exports cannot return to legacy migrations");
  } else if (base.mode === "legacy" && candidate.mode === "declarative") {
    const expected = Object.fromEntries(
      [...legacyClasses(base.migrations)].sort(),
    );
    const actual = Object.fromEntries(
      Object.entries(candidate.exports)
        .filter(([, value]) => value.state === "created")
        .map(([name, value]) => [name, value.storage]),
    );
    const allCreated = Object.values(candidate.exports).every(
      (value) => value.state === "created",
    );
    if (!allCreated || !equal(expected, actual)) {
      invalid = true;
      changes.push(
        "legacy-to-exports transition does not preserve live classes and storage",
      );
    } else {
      phases.add("contract");
      changes.push("one-way legacy-to-exports transition");
    }
  } else if (candidate.mode === "legacy") {
    if (base.mode === "none") {
      if (candidate.migrations.length > 0) phases.add("expand");
    } else if (!isPrefix(base.migrations, candidate.migrations)) {
      invalid = true;
      changes.push("legacy migration history changed or removed");
    }
    const start = base.mode === "legacy" ? base.migrations.length : 0;
    for (const step of candidate.migrations.slice(start)) {
      const expansion =
        step.newClasses.length > 0 ||
        step.newSqliteClasses.length > 0 ||
        step.transferredClasses.length > 0;
      const contraction =
        step.renamedClasses.length > 0 || step.deletedClasses.length > 0;
      if (expansion) phases.add("expand");
      if (contraction) phases.add("contract");
      if (step.transferredClasses.length > 0) {
        manualInspectionReasons.push(
          `legacy transfer ${step.tag} requires exact source Worker namespace inspection`,
        );
      }
      if (!expansion && !contraction) invalid = true;
      changes.push(`legacy migration ${step.tag}`);
    }
    try {
      legacyClasses(candidate.migrations);
    } catch (error) {
      invalid = true;
      changes.push(
        error instanceof Error ? error.message : "invalid legacy class history",
      );
    }
  } else if (candidate.mode === "declarative" || base.mode === "declarative") {
    const before = base.mode === "declarative" ? base.exports : {};
    const renameTargets = new Set(
      Object.values(candidate.exports)
        .filter((value) => value.state === "renamed")
        .map((value) => value.renamedTo),
    );
    for (const [name, value] of Object.entries(candidate.exports)) {
      const previous = before[name];
      if (previous === undefined) {
        if (value.state === "created" && !renameTargets.has(name)) {
          phases.add("expand");
          if (value.storage === "legacy-kv") {
            invalid = true;
            changes.push(
              `new declarative export cannot provision legacy-kv: ${name}`,
            );
          }
        } else if (value.state === "expecting-transfer") {
          phases.add("expand");
          manualInspectionReasons.push(
            `transfer target ${name} requires exact source Worker namespace inspection`,
          );
        } else if (value.state !== "created") invalid = true;
        changes.push(`declarative export added: ${name} (${value.state})`);
      } else if (!equal(previous, value)) {
        const validContract =
          (previous.state === "created" &&
            ["deleted", "renamed", "transferred"].includes(value.state)) ||
          (previous.state === "expecting-transfer" &&
            value.state === "created" &&
            previous.storage === value.storage);
        if (validContract) phases.add("contract");
        else invalid = true;
        if (
          previous.state === "created" &&
          ["deleted", "renamed"].includes(value.state)
        ) {
          manualInspectionReasons.push(
            `${value.state} tombstone ${name} requires authoritative reconciliation inspection`,
          );
        }
        if (previous.state === "created" && value.state === "transferred") {
          manualInspectionReasons.push(
            `transfer source ${name} requires matching target expecting-transfer provider state`,
          );
        }
        if (
          previous.state === "expecting-transfer" &&
          value.state === "created"
        ) {
          manualInspectionReasons.push(
            `transfer target ${name} requires committed source transfer provider state`,
          );
        }
        changes.push(
          `declarative export changed: ${name} (${previous.state} -> ${value.state})`,
        );
      }
    }
    for (const name of Object.keys(before)) {
      if (!(name in candidate.exports)) {
        phases.add("contract");
        changes.push(`declarative export/tombstone removed: ${name}`);
        if (before[name].state === "created") {
          invalid = true;
          changes.push(
            `live declarative export removed without tombstone: ${name}`,
          );
        } else if (
          ["deleted", "renamed", "transferred"].includes(before[name].state)
        ) {
          manualInspectionReasons.push(
            `tombstone ${name} removal requires provider removable_entries proof`,
          );
        } else if (before[name].state === "expecting-transfer") {
          manualInspectionReasons.push(
            `pending transfer ${name} cancellation requires target reconciliation inspection`,
          );
        }
      }
    }
  } else if (base.mode !== "none") {
    invalid = true;
    changes.push("Durable Object lifecycle configuration removed");
  }

  const hasChange = !equal(base, candidate);
  const phase =
    phases.size === 0 ? "none" : phases.size === 1 ? [...phases][0] : "mixed";
  return {
    hasChange,
    phase,
    invalid,
    manualInspectionRequired: manualInspectionReasons.length > 0,
    manualInspectionReasons,
    changes,
    baseDigest: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
    digest: createHash("sha256")
      .update(JSON.stringify(candidate))
      .digest("hex"),
    baseMode: base.mode,
    mode: candidate.mode,
  };
}

function remoteBindings(result) {
  const raw = result?.resources?.bindings;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((binding) => binding?.type === "durable_object_namespace")
    .map((binding) => ({
      name: binding?.name ?? null,
      className: binding?.class_name ?? null,
      scriptName: binding?.script_name ?? null,
      environment: binding?.environment ?? null,
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function remoteHandlers(result) {
  const raw = result?.resources?.script?.named_handlers;
  if (!Array.isArray(raw)) return null;
  const handlers = raw.map((entry) => entry?.name);
  if (
    !raw.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        IDENTIFIER_RE.test(entry.name) &&
        Array.isArray(entry.handlers) &&
        entry.handlers.every((handler) => typeof handler === "string"),
    ) ||
    new Set(handlers).size !== handlers.length
  ) {
    return null;
  }
  return new Set(handlers);
}

function remoteExports(runtime) {
  if (!Object.hasOwn(runtime, "exports")) return null;
  const raw = runtime.exports;
  const entries = Array.isArray(raw)
    ? raw.map((value) => [value?.name ?? value?.class_name, value])
    : raw !== null && typeof raw === "object"
      ? Object.entries(raw)
      : null;
  if (!entries) return null;
  const normalized = {};
  for (const [name, value] of entries) {
    if (!IDENTIFIER_RE.test(name) || Object.hasOwn(normalized, name))
      return null;
    if (value?.type === "worker") {
      if (
        (value.state !== undefined && value.state !== "created") ||
        (value.cache !== undefined &&
          (value.cache === null ||
            typeof value.cache !== "object" ||
            typeof value.cache.enabled !== "boolean"))
      ) {
        return null;
      }
      continue;
    }
    if (value?.type !== "durable-object") return null;
    const state = value.state ?? "created";
    const candidate = {
      type: value.type,
      state,
      ...(value.storage === undefined ? {} : { storage: value.storage }),
      ...(value.renamed_to === undefined && value.renamedTo === undefined
        ? {}
        : { renamed_to: value.renamed_to ?? value.renamedTo }),
      ...(value.transferred_to === undefined &&
      value.transferredTo === undefined
        ? {}
        : { transferred_to: value.transferred_to ?? value.transferredTo }),
      ...(value.transfer_from === undefined && value.transferFrom === undefined
        ? {}
        : { transfer_from: value.transfer_from ?? value.transferFrom }),
    };
    try {
      normalized[name] = normalizeExport(name, candidate);
    } catch {
      return null;
    }
  }
  return canonical(normalized);
}

export function remoteLifecycleProof(
  remotePayload,
  candidateConfig,
  environment,
) {
  const candidate = lifecycleProjection(candidateConfig, environment);
  const result = remotePayload?.result ?? remotePayload;
  const reasons = [];
  if (result === null || typeof result !== "object")
    reasons.push("version result missing");
  const bindings = remoteBindings(result);
  if (bindings === null) reasons.push("version bindings metadata missing");
  else if (!equal(bindings, candidate.bindings))
    reasons.push("Durable Object bindings differ");
  const runtime = result?.resources?.script_runtime;
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    Array.isArray(runtime)
  ) {
    reasons.push("script_runtime metadata missing");
  }
  const handlers = remoteHandlers(result);
  if (handlers === null) reasons.push("named handler metadata missing");

  let expectedLive = new Map();
  if (candidate.mode === "legacy") {
    expectedLive = legacyClasses(candidate.migrations);
    if (!runtime || !Object.hasOwn(runtime, "migration_tag")) {
      reasons.push("legacy migration_tag metadata missing");
    } else if (
      (runtime.migration_tag ?? null) !== candidate.migrations.at(-1)?.tag
    ) {
      reasons.push("legacy migration tag differs");
    }
    if (runtime && Object.hasOwn(runtime, "exports")) {
      const actualExports = remoteExports(runtime);
      if (actualExports === null)
        reasons.push("declarative exports metadata incomplete");
      else if (Object.keys(actualExports).length > 0)
        reasons.push("provider reports declarative exports for legacy config");
    }
  } else if (candidate.mode === "declarative") {
    if (
      runtime?.migration_tag !== null &&
      runtime?.migration_tag !== undefined
    ) {
      reasons.push("provider still reports legacy migration tag");
    }
    const actualExports = runtime ? remoteExports(runtime) : null;
    if (actualExports === null)
      reasons.push("declarative exports metadata missing or incomplete");
    const liveExports = canonical(
      Object.fromEntries(
        Object.entries(candidate.exports).filter(
          ([, value]) =>
            value.state === "created" || value.state === "expecting-transfer",
        ),
      ),
    );
    if (actualExports !== null && !equal(actualExports, liveExports)) {
      reasons.push("live declarative exports differ");
    }
    if (
      Object.values(candidate.exports).some((value) =>
        ["deleted", "renamed", "transferred"].includes(value.state),
      )
    ) {
      reasons.push(
        "provider version metadata cannot prove declarative tombstones",
      );
    }
    expectedLive = new Map(
      Object.entries(liveExports).map(([name, value]) => [name, value.storage]),
    );
  } else {
    if (
      runtime?.migration_tag !== null &&
      runtime?.migration_tag !== undefined
    ) {
      reasons.push("provider reports unexpected legacy lifecycle");
    }
    if (runtime && Object.hasOwn(runtime, "exports")) {
      const actualExports = remoteExports(runtime);
      if (actualExports === null)
        reasons.push("declarative exports metadata incomplete");
      else if (Object.keys(actualExports).length > 0)
        reasons.push("provider reports unexpected declarative lifecycle");
    }
  }

  if (handlers !== null) {
    for (const name of expectedLive.keys()) {
      if (!handlers.has(name)) reasons.push(`named handler missing: ${name}`);
    }
  }
  return {
    provable: !reasons.some(
      (reason) =>
        reason.includes("missing") ||
        reason.includes("incomplete") ||
        reason.includes("cannot prove"),
    ),
    matches: reasons.length === 0,
    reasons,
  };
}

export function remoteLifecycleMatches(
  remotePayload,
  candidateConfig,
  environment,
) {
  return remoteLifecycleProof(remotePayload, candidateConfig, environment)
    .matches;
}

export function verifyRemoteVersionIdentity(remotePayload, expectedVersion) {
  const result = remotePayload?.result ?? remotePayload;
  if (
    !VERSION_RE.test(expectedVersion ?? "") ||
    result?.id !== expectedVersion
  ) {
    throw new Error("Cloudflare version detail does not match requested id");
  }
  return true;
}

function parseArgs(argv) {
  const [command, ...raw] = argv;
  const args = {};
  for (const entry of raw) {
    if (!entry.startsWith("--") || !entry.includes("="))
      throw new Error(`Invalid argument: ${entry}`);
    const [key, ...value] = entry.slice(2).split("=");
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate argument: ${key}`);
    args[key] = value.join("=");
  }
  return { command, args };
}

function readJsonc(path) {
  if (!path) throw new Error("Configuration path is required");
  return parseJsonc(readFileSync(path, "utf8"));
}

export function run(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv);
  const candidate = readJsonc(args.candidate);
  const environment = args.environment || undefined;
  if (command === "classify") {
    const base = readJsonc(args.base);
    const classification = classifyLifecycleChange(
      base,
      candidate,
      environment,
    );
    process.stdout.write(`${JSON.stringify(classification)}\n`);
    return classification;
  }

  const remote = JSON.parse(readFileSync(args["active-version"], "utf8"));
  const expectedVersion = args["expected-version"];
  verifyRemoteVersionIdentity(remote, expectedVersion);
  const proof = remoteLifecycleProof(remote, candidate, environment);
  if (command === "verify-remote") {
    if (!proof.provable) {
      throw new Error(
        `Cloudflare metadata cannot prove DO state; manual inspection required: ${proof.reasons.join("; ")}`,
      );
    }
    if (!proof.matches)
      throw new Error(
        `Active Cloudflare DO state differs: ${proof.reasons.join("; ")}`,
      );
    process.stdout.write(
      `${JSON.stringify({ digest: lifecycleDigest(candidate, environment), mode: lifecycleProjection(candidate, environment).mode })}\n`,
    );
    return proof;
  }

  if (command === "check-generic") {
    const base = readJsonc(args.base ?? args.active);
    const classification = classifyLifecycleChange(
      base,
      candidate,
      environment,
    );
    if (classification.hasChange) {
      throw new Error(
        "Generic release must skip Durable Object lifecycle diffs; dedicated workflow exclusively owns production",
      );
    }
    if (!proof.provable || !proof.matches) {
      throw new Error(
        `Cloudflare metadata cannot prove reviewed DO state; manual inspection required: ${proof.reasons.join("; ")}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ eligible: true, digest: classification.digest })}\n`,
    );
    return classification;
  }

  if (command === "check-dedicated") {
    const base = readJsonc(args.base ?? args.active);
    const activeProof = remoteLifecycleProof(remote, base, environment);
    const classification = classifyLifecycleChange(
      base,
      candidate,
      environment,
    );
    if (!activeProof.provable || !activeProof.matches) {
      throw new Error(
        `Cloudflare metadata cannot prove active DO state; manual inspection required: ${activeProof.reasons.join("; ")}`,
      );
    }
    if (!classification.hasChange)
      throw new Error("Dedicated workflow requires a DO lifecycle change");
    if (
      classification.invalid ||
      classification.manualInspectionRequired ||
      classification.phase === "mixed" ||
      classification.phase === "none"
    ) {
      throw new Error(
        `DO lifecycle is rewritten, unclassified, mixes expand and contract, or requires manual provider inspection: ${classification.manualInspectionReasons.join("; ")}`,
      );
    }
    if (classification.phase !== args.phase) {
      throw new Error(
        `DO lifecycle requires ${classification.phase} phase, not ${args.phase}`,
      );
    }
    process.stdout.write(`${JSON.stringify(classification)}\n`);
    return classification;
  }
  throw new Error(
    "Usage: release-lifecycle.mjs classify|verify-remote|check-generic|check-dedicated",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    run();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Lifecycle check failed",
    );
    process.exitCode = 1;
  }
}
