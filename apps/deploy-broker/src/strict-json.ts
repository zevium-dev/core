import { BrokerError } from "./errors.ts";

class StrictJsonParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail("trailing data");
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1;
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return output;
    }

    while (this.index < this.source.length) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"')
        this.fail("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.fail("missing colon");
      this.index += 1;
      output[key] = this.parseValue();
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return output;
      }
      if (delimiter !== ",") this.fail("missing object delimiter");
      this.index += 1;
    }
    this.fail("unterminated object");
  }

  private parseArray(): unknown[] {
    this.index += 1;
    const output: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return output;
    }
    while (this.index < this.source.length) {
      output.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return output;
      }
      if (delimiter !== ",") this.fail("missing array delimiter");
      this.index += 1;
    }
    this.fail("unterminated array");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          this.fail("invalid string escape");
        }
      }
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.fail("invalid string character");
      }
      this.index += 1;
    }
    this.fail("unterminated string");
  }

  private parseNumber(): number {
    const remainder = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      remainder,
    );
    if (!match) this.fail("invalid value");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number is not finite");
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (
      this.source.slice(this.index, this.index + literal.length) !== literal
    ) {
      this.fail("invalid literal");
    }
    this.index += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private fail(message: string): never {
    throw new BrokerError(400, "invalid_json", `Invalid JSON: ${message}`);
  }
}

export function parseStrictJson(source: string): unknown {
  return new StrictJsonParser(source).parse();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

export async function readBodyBounded(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new BrokerError(
        400,
        "invalid_content_length",
        "Content-Length is invalid",
      );
    }
    if (Number(declaredLength) > maximumBytes) {
      throw new BrokerError(
        413,
        "body_too_large",
        "Request body exceeds route limit",
      );
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("body limit exceeded");
      throw new BrokerError(
        413,
        "body_too_large",
        "Request body exceeds route limit",
      );
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readJsonBounded(
  request: Request,
  maximumBytes: number,
): Promise<{ bytes: Uint8Array; value: unknown }> {
  const contentType = request.headers.get("content-type");
  if (contentType !== "application/json") {
    throw new BrokerError(
      415,
      "invalid_content_type",
      "Content-Type must be application/json",
    );
  }
  const bytes = await readBodyBounded(request, maximumBytes);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrokerError(400, "invalid_utf8", "JSON body must be UTF-8");
  }
  return { bytes, value: parseStrictJson(source) };
}
