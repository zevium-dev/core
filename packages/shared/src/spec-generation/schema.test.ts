import { describe, expect, it } from "vitest";
import { schemaProjector } from "./schema.js";
import { generateSpecContract } from "./index.js";

const wide = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`x-${i}`, i]));

// Count actual source field reads/enumeration, not elapsed time or an internal
// counter that could miss uncharged spreads. Unknown values must never be read.
function observed(value: Record<string, unknown>) {
  const work = { reads: 0, fields: 0 };
  return {
    work,
    value: new Proxy(value, {
      get(target, key, receiver) {
        work.reads++;
        if (typeof key === "string" && key.startsWith("x-"))
          throw new Error("extension value read");
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        work.fields++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }),
  };
}

describe("generation work budget", () => {
  it("rejects the 6,000-field / 4,500-ref parameter amplification repro", () => {
    const spec = JSON.stringify({
      openapi: "3.1.0",
      components: {
        parameters: {
          P: {
            name: "q",
            in: "query",
            schema: { type: "string" },
            ...wide(6_000),
          },
        },
      },
      paths: {
        "/test": {
          get: {
            "x-zevium-cost": 0,
            parameters: Array.from({ length: 4_500 }, () => ({
              $ref: "#/components/parameters/P",
              description: "sibling",
            })),
          },
        },
      },
    });
    expect(new TextEncoder().encode(spec).byteLength).toBeLessThan(393_216);
    expect(() => generateSpecContract({ spec, version: "1" })).toThrow(
      "complexity_limit",
    );
  });

  it.each([false, true])(
    "bounds wide repeated references (schema=%s)",
    (schema) => {
      const target = observed(
        schema
          ? { type: "string", ...wide(6_000) }
          : {
              name: "q",
              in: "query",
              schema: { type: "string" },
              ...wide(6_000),
            },
      );
      const group = schema ? "schemas" : "parameters";
      const projector = schemaProjector({
        components: { [group]: { P: target.value } },
      });
      const expand = schema ? projector.schema : projector.resolve;
      expect(() => {
        for (let i = 0; i < 4_500; i++)
          expand({ $ref: `#/components/${group}/P`, description: "sibling" });
      }).toThrow("complexity_limit");
      expect(target.work.fields).toBeLessThanOrEqual(24_000);
      expect(target.work.reads).toBeLessThan(20);
    },
  );

  it("charges narrow refs even when duplicate parameters would later collapse", () => {
    const target = observed({
      name: "q",
      in: "query",
      schema: { type: "string" },
    });
    const projector = schemaProjector({
      components: { parameters: { P: target.value } },
    });
    let completed = 0;
    expect(() => {
      for (; completed < 4_500; completed++)
        projector.resolve({
          $ref: "#/components/parameters/P",
          description: "override",
        });
    }).toThrow("complexity_limit");
    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThan(200);
    expect(target.work.reads + target.work.fields).toBeLessThan(2_000);
  });

  it.each([false, true])(
    "bounds deep ref chains before merging (schema=%s)",
    (schema) => {
      const group = schema ? "schemas" : "parameters";
      const targets = Array.from({ length: 100 }, (_, i) =>
        observed({
          $ref: `#/components/${group}/P${i + 1}`,
          description: "sibling",
          ...wide(100),
        }),
      );
      const projector = schemaProjector({
        components: {
          [group]: Object.fromEntries(
            targets.map((target, i) => [`P${i}`, target.value]),
          ),
        },
      });
      const expand = schema ? projector.schema : projector.resolve;
      expect(() => expand({ $ref: `#/components/${group}/P0` })).toThrow(
        schema ? "complexity_limit" : "recursive_reference",
      );
      expect(
        targets.reduce((n, target) => n + target.work.fields, 0),
      ).toBeLessThan(7_000);
      expect(targets.slice(33).every((target) => target.work.reads === 0)).toBe(
        true,
      );
    },
  );

  it("bounds wide schema maps and scalar arrays before expansion", () => {
    const properties = observed(
      Object.fromEntries(
        Array.from({ length: 20_000 }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
    );
    expect(() =>
      schemaProjector({}).schema({ properties: properties.value }),
    ).toThrow("complexity_limit");
    expect(properties.work.fields).toBeLessThanOrEqual(24_000);
    expect(properties.work.reads).toBe(0);
    let reads = 0;
    const entries = new Proxy(
      Array.from({ length: 20_000 }, () => "string"),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    for (const key of ["enum", "required", "type", "allOf"])
      expect(() => schemaProjector({}).schema({ [key]: entries })).toThrow(
        "complexity_limit",
      );
    expect(reads).toBe(0);
  });

  it("projects parameter fields before sibling merging and retains schema constraints", () => {
    const target = observed({
      name: "q",
      in: "query",
      description: "old",
      unknown: "drop",
      ...wide(10),
    });
    expect(
      schemaProjector({
        components: { parameters: { P: target.value } },
      }).resolve({
        $ref: "#/components/parameters/P",
        description: "new",
        unknown: "drop",
        "x-extra": "drop",
      }),
    ).toEqual({ name: "q", in: "query", description: "new" });
    expect(() => schemaProjector({}).schema({ $dynamicRef: "#node" })).toThrow(
      "unsupported_schema_keyword",
    );
  });
});
