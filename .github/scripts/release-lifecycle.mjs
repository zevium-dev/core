import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

function migrationStep(step) {
  const normalized = {};
  for (const [key, value] of Object.entries(step ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    normalized[key] = Array.isArray(value)
      ? [...value]
          .map(canonical)
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          )
      : canonical(value);
  }
  return normalized;
}

function durableBindings(config) {
  const bindings = config?.durable_objects?.bindings ?? [];
  if (!Array.isArray(bindings))
    throw new Error("Invalid durable_objects.bindings");
  return bindings
    .map((binding) => ({
      name: binding?.name ?? null,
      className: binding?.class_name ?? null,
      scriptName: binding?.script_name ?? null,
      environment: binding?.environment ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function durableExports(config) {
  const exports = config?.exports ?? {};
  if (
    exports === null ||
    typeof exports !== "object" ||
    Array.isArray(exports)
  ) {
    throw new Error("Invalid exports configuration");
  }
  return Object.fromEntries(
    Object.entries(exports)
      .filter(([, value]) => value?.type === "durable-object")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, canonical(value)]),
  );
}

export function lifecycleProjection(config) {
  const migrations = config?.migrations ?? [];
  if (!Array.isArray(migrations)) throw new Error("Invalid migrations array");
  return {
    bindings: durableBindings(config),
    migrations: migrations.map(migrationStep),
    exports: durableExports(config),
  };
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPrefix(prefix, value) {
  return (
    prefix.length <= value.length &&
    prefix.every((entry, index) => equal(entry, value[index]))
  );
}

export function classifyLifecycleChange(baseConfig, candidateConfig) {
  const base = lifecycleProjection(baseConfig);
  const candidate = lifecycleProjection(candidateConfig);
  const changes = [];
  const phases = new Set();
  let invalid = false;

  if (!isPrefix(base.migrations, candidate.migrations)) {
    changes.push("legacy migration history changed or removed");
    invalid = true;
  } else {
    for (const step of candidate.migrations.slice(base.migrations.length)) {
      const expansion =
        (step.new_classes?.length ?? 0) > 0 ||
        (step.new_sqlite_classes?.length ?? 0) > 0;
      const contraction =
        (step.renamed_classes?.length ?? 0) > 0 ||
        (step.deleted_classes?.length ?? 0) > 0 ||
        (step.transferred_classes?.length ?? 0) > 0;
      if (expansion) phases.add("expand");
      if (contraction) phases.add("contract");
      if (!expansion && !contraction) {
        changes.push(
          `unclassified migration ${String(step.tag ?? "untagged")}`,
        );
        invalid = true;
      } else {
        changes.push(`migration ${String(step.tag ?? "untagged")}`);
      }
    }
  }

  const baseBindings = new Map(
    base.bindings.map((entry) => [entry.name, entry]),
  );
  const candidateBindings = new Map(
    candidate.bindings.map((entry) => [entry.name, entry]),
  );
  for (const [name, binding] of candidateBindings) {
    const previous = baseBindings.get(name);
    if (previous === undefined) {
      phases.add("expand");
      changes.push(`binding added: ${name}`);
    } else if (!equal(previous, binding)) {
      phases.add("contract");
      changes.push(`binding changed: ${name}`);
    }
  }
  for (const name of baseBindings.keys()) {
    if (!candidateBindings.has(name)) {
      phases.add("contract");
      changes.push(`binding removed: ${name}`);
    }
  }

  for (const [name, value] of Object.entries(candidate.exports)) {
    const previous = base.exports[name];
    if (previous === undefined) {
      if ((value.state ?? "created") === "created") phases.add("expand");
      else phases.add("contract");
      changes.push(`Durable Object export added: ${name}`);
    } else if (!equal(previous, value)) {
      phases.add("contract");
      changes.push(`Durable Object export changed: ${name}`);
    }
  }
  for (const name of Object.keys(base.exports)) {
    if (!(name in candidate.exports)) {
      phases.add("contract");
      changes.push(`Durable Object export removed: ${name}`);
    }
  }

  const hasChange = !equal(base, candidate);
  const phase =
    phases.size === 0 ? "none" : phases.size === 1 ? [...phases][0] : "mixed";
  return { hasChange, phase, invalid, changes };
}

function lastMigrationTag(config) {
  const migrations = lifecycleProjection(config).migrations;
  const tag = migrations.at(-1)?.tag;
  return typeof tag === "string" ? tag : null;
}

export function remoteLifecycleMatches(remotePayload, candidateConfig) {
  const result = remotePayload?.result ?? remotePayload;
  const runtime = result?.resources?.script_runtime ?? {};
  const remoteBindings = (result?.resources?.bindings ?? [])
    .filter((binding) => binding?.type === "durable_object_namespace")
    .map((binding) => ({
      name: binding?.name ?? null,
      className: binding?.class_name ?? null,
      scriptName: binding?.script_name ?? null,
      environment: binding?.environment ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return (
    equal(remoteBindings, durableBindings(candidateConfig)) &&
    (runtime.migration_tag ?? null) === lastMigrationTag(candidateConfig)
  );
}

function parseArgs(argv) {
  const [command, ...raw] = argv;
  const args = Object.fromEntries(
    raw.map((entry) => {
      if (!entry.startsWith("--") || !entry.includes("=")) {
        throw new Error(`Invalid argument: ${entry}`);
      }
      const [key, ...value] = entry.slice(2).split("=");
      return [key, value.join("=")];
    }),
  );
  return { command, args };
}

function readJsonc(path) {
  return parseJsonc(readFileSync(path, "utf8"));
}

export function run(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv);
  const candidate = readJsonc(args.candidate);
  const remote = JSON.parse(readFileSync(args["active-version"], "utf8"));
  const remoteMatches = remoteLifecycleMatches(remote, candidate);

  if (command === "check-generic") {
    const active = args.active ? readJsonc(args.active) : null;
    const classification =
      active === null
        ? {
            hasChange: !remoteMatches,
            phase: "unknown",
            invalid: false,
            changes: [],
          }
        : classifyLifecycleChange(active, candidate);
    if (!classification.hasChange && !remoteMatches) {
      throw new Error(
        "Active Cloudflare Durable Object lifecycle differs from reviewed source",
      );
    }
    if (classification.hasChange) {
      if (remoteMatches && args.marker === "success") {
        process.stdout.write(
          "Durable Object lifecycle already applied and marked\n",
        );
        return;
      }
      throw new Error(
        "Durable Object lifecycle change requires reviewed Gateway DO Lifecycle workflow; generic rollback is prohibited",
      );
    }
    process.stdout.write("No Durable Object lifecycle change detected\n");
    return;
  }

  if (command === "check-dedicated") {
    const active = readJsonc(args.active);
    const classification = classifyLifecycleChange(active, candidate);
    if (!remoteLifecycleMatches(remote, active)) {
      throw new Error(
        "Active Cloudflare Durable Object lifecycle differs from reviewed active source",
      );
    }
    if (!classification.hasChange) {
      throw new Error(
        "Dedicated workflow requires a Durable Object lifecycle change",
      );
    }
    if (classification.invalid || classification.phase === "mixed") {
      throw new Error(
        "Durable Object lifecycle history is rewritten, unclassified, or mixes expand and contract",
      );
    }
    if (classification.phase !== args.phase) {
      throw new Error(
        `Durable Object lifecycle requires ${classification.phase} phase, not ${args.phase}`,
      );
    }
    if (remoteMatches) {
      throw new Error("Durable Object lifecycle is already active");
    }
    process.stdout.write(
      `${JSON.stringify({ phase: classification.phase, changes: classification.changes })}\n`,
    );
    return;
  }

  throw new Error("Usage: release-lifecycle.mjs check-generic|check-dedicated");
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
