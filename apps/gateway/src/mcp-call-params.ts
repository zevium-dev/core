const scalarSchema = { type: ["string", "number", "boolean"] };

export const callParameterSchemas = {
  pathParams: {
    type: "object",
    description:
      "Values for {name} placeholders in path, keyed by the documented path parameter name. Values are percent-encoded.",
    additionalProperties: scalarSchema,
  },
  query: {
    type: "object",
    description:
      "Query parameters by name. Scalars are encoded; arrays repeat the name (form/explode). For other OpenAPI styles, supply pre-serialized strings or an encoded query string in path. These entries replace same-name inline query parameters.",
    additionalProperties: {
      anyOf: [scalarSchema, { type: "array", items: scalarSchema }],
    },
  },
};

function scalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function entries(value: unknown): [string, unknown][] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Parameters must be objects");
  }
  return Object.entries(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function assertSafePath(path: string) {
  // Check before URL normalization, including encoded separators/dot segments.
  // Repeated decoding also catches traversal hidden behind double encoding.
  let decoded = path;
  for (let depth = 0; depth < 8; depth++) {
    if (
      decoded.startsWith("//") ||
      decoded.includes("\\") ||
      hasControlCharacter(decoded) ||
      decoded.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("Unsafe path");
    }
    if (!/%[0-9a-f]{2}/i.test(decoded)) return;
    // Decode only complete escapes so literal percent signs remain usable.
    decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  throw new Error("Path encoding is too deeply nested");
}

/** Separate routing from search; never resolve caller input as a URL/host. */
export function callTarget(
  origin: string,
  org: string,
  project: string,
  path: string,
  pathParams: unknown,
  query: unknown,
): { url: URL; remainderPath: string } {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.includes("#") ||
    hasControlCharacter(path)
  ) {
    throw new Error("Expected an endpoint path");
  }
  const queryStart = path.indexOf("?");
  const template = queryStart < 0 ? path : path.slice(0, queryStart);
  const search = new URLSearchParams(
    queryStart < 0 ? "" : path.slice(queryStart + 1),
  );
  const params = new Map(entries(pathParams));
  let pathname = template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = params.get(name);
    if (!scalar(value) || String(value).length === 0) {
      throw new Error("Missing path parameter");
    }
    return encodeURIComponent(String(value));
  });
  if (/[{}]/.test(pathname)) throw new Error("Invalid path template");
  for (const [name, value] of params) {
    if (!scalar(value) || !template.includes(`{${name}}`)) {
      throw new Error("Invalid path parameter");
    }
  }
  pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  assertSafePath(pathname);
  for (const segment of [org, project]) {
    assertSafePath(`/${segment}`);
    if (/[/?#\\]/.test(segment)) throw new Error("Invalid API identifier");
  }
  for (const [name, value] of entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    if (!values.every(scalar)) throw new Error("Invalid query parameter");
    search.delete(name);
    for (const item of values) search.append(name, String(item));
  }
  // Canonicalize encoding without allowing path normalization to hide traversal.
  const endpoint = new URL("https://mcp.invalid");
  endpoint.pathname = pathname;
  const remainderPath = endpoint.pathname;
  const url = new URL(origin);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/gateway/${encodeURIComponent(org)}/${encodeURIComponent(project)}${remainderPath === "/" ? "" : remainderPath}`;
  url.search = search.toString();
  url.hash = "";
  return { url, remainderPath };
}
