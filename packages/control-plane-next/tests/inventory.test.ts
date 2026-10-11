import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import inventory from "../contracts/inventory.json";
import historical from "../contracts/historical-fixtures.json";
import surfaces from "../contracts/surface-fixtures.json";
import tables from "../contracts/tables.json";
const root = fileURLToPath(new URL("../../../", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() &&
    !["node_modules", "_generated", ".wrangler", "dist"].includes(e.name)
      ? files(path.join(dir, e.name))
      : e.isFile() && /\.(ts|tsx)$/.test(e.name)
        ? [path.join(dir, e.name)]
        : [],
  );
}
describe("contract inventory coverage and isolation", () => {
  it("classifies each registered function and historical entry without claiming future parity", () => {
    expect(new Set(inventory.functions.map((f) => f.name)).size).toBe(
      inventory.counts.registeredFunctions,
    );
    expect(Object.keys(historical)).toHaveLength(81);
    for (const name of Object.keys(historical))
      expect(
        inventory.functions.some((f) => f.name === name) ||
          inventory.missingHistorical.includes(name),
      ).toBe(true);
    for (const entry of inventory.functions) {
      expect(["retained", "changed", "retired"]).toContain(entry.status);
      expect(entry.fixture).toBeTruthy();
      expect(entry.implementation).toBe("pending");
    }
    expect(inventory.missingReferences).toEqual([]);
    for (const route of inventory.routes.filter((r) => r.status !== "retired"))
      expect(Object.keys(surfaces.http)).toContain(
        `${route.method} ${route.route}`,
      );
    expect(
      inventory.functions.find((f) => f.name === "catalogue:listPublic")?.args,
    ).not.toBeNull();
  });
  it("includes literal public-query gateway callers", () => {
    expect(
      inventory.functions.find((f) => f.name === "specs:getPublishedForGateway")
        ?.appCallers,
    ).toContain("apps/gateway/src/spec-source.ts");
    expect(
      inventory.functions.find((f) => f.name === "catalogue:listPublic")
        ?.appCallers,
    ).toContain("apps/gateway/src/catalogue-source.ts");
  });
  it("forbids production imports or next URL selection before paired cutover", () => {
    for (const folder of ["apps/web/src", "apps/gateway/src", "convex"]) {
      for (const file of files(path.join(root, folder)).filter(
        (f) => !f.endsWith(".test.ts"),
      )) {
        expect(readFileSync(file, "utf8")).not.toMatch(
          /control-plane-next|next\/convex\/_generated/,
        );
      }
    }
  });
  it("counts nested component physical tables from installed code", () => {
    const rate = realpathSync(
      path.join(root, "node_modules/@convex-dev/rate-limiter"),
    );
    const paths = {
      rateLimiter: path.join(rate, "src/component/schema.ts"),
      "rateLimiter/batchWorker": path.join(
        rate,
        "../batch-worker/src/component/schema.ts",
      ),
    };
    for (const [name, file] of Object.entries(paths)) {
      const found = Array.from(
        readFileSync(file, "utf8").matchAll(/^\s+(\w+): defineTable\(/gm),
        (m) => m[1],
      );
      expect(found).toEqual(
        tables.components[name as keyof typeof tables.components],
      );
    }
  });
});
