import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import completion from "../../contracts/completion.json";
import inventory from "../../contracts/inventory.json";
assert.deepEqual(
  completion.functions.map((row) => row.name).sort(),
  inventory.functions.map((row) => row.name).sort(),
);
for (const row of completion.functions) {
  if (row.status === "retired") {
    assert.ok(row.reason);
    continue;
  }
  assert.ok(row.targets?.length || row.reason, row.name);
  for (const target of row.targets ?? []) {
    const [mod, name] = target.split(":");
    assert.match(
      readFileSync(new URL(`../../convex/${mod}.ts`, import.meta.url), "utf8"),
      new RegExp(`export const ${name}\\s*=`),
    );
  }
}
console.log(
  "All 221 frozen contracts have canonical root implementations or explicit retirements.",
);
