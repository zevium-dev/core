import type { OpenApiOperation } from "@zevium/shared";

export type TryItBodyDefaults = {
  contentType: string;
  body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeExample(value: unknown, contentType: string): string {
  if (typeof value === "string") return value;
  if (contentType.toLowerCase().includes("json")) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/** Derive playground media type and initial body from OpenAPI requestBody. */
export function tryItBodyDefaults(
  operation: OpenApiOperation,
): TryItBodyDefaults {
  const requestBody = operation.requestBody;
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return { contentType: "application/json", body: "{\n  \n}" };
  }

  const content = requestBody.content;
  const selected =
    (isRecord(content["application/json"])
      ? (["application/json", content["application/json"]] as const)
      : Object.entries(content).find((entry) => isRecord(entry[1]))) ?? null;
  if (selected === null || !isRecord(selected[1])) {
    return { contentType: "application/json", body: "{\n  \n}" };
  }

  const [contentType, media] = selected;
  if ("example" in media) {
    return {
      contentType,
      body: serializeExample(media.example, contentType),
    };
  }
  if (isRecord(media.schema) && "example" in media.schema) {
    return {
      contentType,
      body: serializeExample(media.schema.example, contentType),
    };
  }
  return {
    contentType,
    body: contentType.toLowerCase().includes("json") ? "{\n  \n}" : "",
  };
}
