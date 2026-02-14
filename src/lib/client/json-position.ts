interface JsonCursor {
  index: number;
  source: string;
}

const positionPattern = /position\s+(\d+)/i;

const toLineAndColumn = (source: string, offset: number) => {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset && index < source.length; index += 1) {
    const char = source[index];

    if (char === "\n") {
      line += 1;
      column = 1;
      continue;
    }

    if (char === "\r") {
      if (source[index + 1] === "\n") {
        index += 1;
      }

      line += 1;
      column = 1;
      continue;
    }

    column += 1;
  }

  return { column, line };
};

const parsePositionOffset = (message: string) => {
  const match = positionPattern.exec(message);
  if (!match) return null;

  const offsetText = match.at(1);
  if (!offsetText) return null;

  const offset = Number.parseInt(offsetText, 10);
  return Number.isFinite(offset) ? offset : null;
};

const isJsonWhitespace = (char: string | undefined) => char === " " || char === "\n" || char === "\r" || char === "\t";

const skipWhitespace = (cursor: JsonCursor) => {
  while (isJsonWhitespace(cursor.source[cursor.index])) {
    cursor.index += 1;
  }
};

const parseJsonString = (cursor: JsonCursor): null | string => {
  const source = cursor.source;
  if (source[cursor.index] !== '"') return null;

  cursor.index += 1;
  let value = "";

  while (cursor.index < source.length) {
    const char = source[cursor.index];

    if (char === '"') {
      cursor.index += 1;
      return value;
    }

    if (char === "\\") {
      cursor.index += 1;
      const escape = source[cursor.index];

      if (escape === '"' || escape === "\\" || escape === "/") {
        value += escape;
        cursor.index += 1;
        continue;
      }

      if (escape === "b") {
        value += "\b";
        cursor.index += 1;
        continue;
      }

      if (escape === "f") {
        value += "\f";
        cursor.index += 1;
        continue;
      }

      if (escape === "n") {
        value += "\n";
        cursor.index += 1;
        continue;
      }

      if (escape === "r") {
        value += "\r";
        cursor.index += 1;
        continue;
      }

      if (escape === "t") {
        value += "\t";
        cursor.index += 1;
        continue;
      }

      if (escape === "u") {
        const hex = source.slice(cursor.index + 1, cursor.index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor.index += 5;
        continue;
      }

      return null;
    }

    value += char;
    cursor.index += 1;
  }

  return null;
};

const parseJsonNumber = (cursor: JsonCursor) => {
  const source = cursor.source;
  const start = cursor.index;
  const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));
  if (!numberMatch) return false;

  const parsedNumber = numberMatch.at(0);
  if (!parsedNumber) return false;

  cursor.index += parsedNumber.length;
  return true;
};

const parseJsonLiteral = (cursor: JsonCursor, literal: "false" | "null" | "true") => {
  if (!cursor.source.startsWith(literal, cursor.index)) return false;
  cursor.index += literal.length;
  return true;
};

const skipJsonValue = (cursor: JsonCursor): boolean => {
  skipWhitespace(cursor);
  const token = cursor.source[cursor.index];

  if (token === "{") {
    cursor.index += 1;
    skipWhitespace(cursor);

    if (cursor.source[cursor.index] === "}") {
      cursor.index += 1;
      return true;
    }

    while (cursor.index < cursor.source.length) {
      skipWhitespace(cursor);
      const key = parseJsonString(cursor);
      if (key === null) return false;

      skipWhitespace(cursor);
      if (cursor.source[cursor.index] !== ":") return false;
      cursor.index += 1;

      if (!skipJsonValue(cursor)) return false;

      skipWhitespace(cursor);
      const separator = cursor.source[cursor.index];
      if (separator === ",") {
        cursor.index += 1;
        skipWhitespace(cursor);
        continue;
      }

      if (separator === "}") {
        cursor.index += 1;
        return true;
      }

      return false;
    }

    return false;
  }

  if (token === "[") {
    cursor.index += 1;
    skipWhitespace(cursor);

    if (cursor.source[cursor.index] === "]") {
      cursor.index += 1;
      return true;
    }

    while (cursor.index < cursor.source.length) {
      if (!skipJsonValue(cursor)) return false;

      skipWhitespace(cursor);
      const separator = cursor.source[cursor.index];
      if (separator === ",") {
        cursor.index += 1;
        continue;
      }

      if (separator === "]") {
        cursor.index += 1;
        return true;
      }

      return false;
    }

    return false;
  }

  if (token === '"') return parseJsonString(cursor) !== null;
  if (token === "t") return parseJsonLiteral(cursor, "true");
  if (token === "f") return parseJsonLiteral(cursor, "false");
  if (token === "n") return parseJsonLiteral(cursor, "null");

  return parseJsonNumber(cursor);
};

const findJsonSyntaxErrorOffset = (rawDraft: string) => {
  const cursor: JsonCursor = { index: 0, source: rawDraft };
  const parsed = skipJsonValue(cursor);
  if (!parsed) return cursor.index;

  skipWhitespace(cursor);
  return cursor.index < rawDraft.length ? cursor.index : null;
};

const findOffsetInJsonValue = (
  cursor: JsonCursor,
  pathSegments: Array<number | string>,
  depth: number,
): null | number => {
  skipWhitespace(cursor);
  const valueStart = cursor.index;

  if (depth === pathSegments.length) {
    return skipJsonValue(cursor) ? valueStart : null;
  }

  const token = cursor.source[cursor.index];

  if (token === "{") {
    cursor.index += 1;
    skipWhitespace(cursor);

    if (cursor.source[cursor.index] === "}") {
      cursor.index += 1;
      return null;
    }

    const expectedSegment = pathSegments[depth];
    const expectedKey = String(expectedSegment);

    while (cursor.index < cursor.source.length) {
      const key = parseJsonString(cursor);
      if (key === null) return null;

      skipWhitespace(cursor);
      if (cursor.source[cursor.index] !== ":") return null;
      cursor.index += 1;

      if (key === expectedKey) {
        const result = findOffsetInJsonValue(cursor, pathSegments, depth + 1);
        if (result !== null) return result;
      } else if (!skipJsonValue(cursor)) {
        return null;
      }

      skipWhitespace(cursor);
      const separator = cursor.source[cursor.index];
      if (separator === ",") {
        cursor.index += 1;
        skipWhitespace(cursor);
        continue;
      }

      if (separator === "}") {
        cursor.index += 1;
        return null;
      }

      return null;
    }

    return null;
  }

  if (token === "[") {
    cursor.index += 1;
    skipWhitespace(cursor);

    const expectedSegment = pathSegments[depth];
    const expectedIndex =
      typeof expectedSegment === "number"
        ? expectedSegment
        : /^\d+$/.test(expectedSegment)
          ? Number.parseInt(expectedSegment, 10)
          : Number.NaN;

    if (!Number.isInteger(expectedIndex)) {
      cursor.index = valueStart;
      if (!skipJsonValue(cursor)) return null;
      return null;
    }

    if (cursor.source[cursor.index] === "]") {
      cursor.index += 1;
      return null;
    }

    let itemIndex = 0;

    while (cursor.index < cursor.source.length) {
      if (itemIndex === expectedIndex) {
        const result = findOffsetInJsonValue(cursor, pathSegments, depth + 1);
        if (result !== null) return result;
      } else if (!skipJsonValue(cursor)) {
        return null;
      }

      skipWhitespace(cursor);
      const separator = cursor.source[cursor.index];
      if (separator === ",") {
        cursor.index += 1;
        itemIndex += 1;
        skipWhitespace(cursor);
        continue;
      }

      if (separator === "]") {
        cursor.index += 1;
        return null;
      }

      return null;
    }

    return null;
  }

  if (!skipJsonValue(cursor)) return null;
  return null;
};

const findJsonPathOffset = (rawDraft: string, pathSegments: Array<number | string>) => {
  const cursor: JsonCursor = { index: 0, source: rawDraft };
  skipWhitespace(cursor);
  return findOffsetInJsonValue(cursor, pathSegments, 0);
};

export const parseJsonPath = (path: string) =>
  path
    .split(".")
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment));

export const resolveJsonParseErrorPosition = (rawDraft: string, message: string) => {
  const offset = parsePositionOffset(message) ?? findJsonSyntaxErrorOffset(rawDraft);
  return offset === null ? null : toLineAndColumn(rawDraft, offset);
};

export const resolveJsonPathPosition = (rawDraft: string, pathSegments: Array<number | string>) => {
  for (let depth = pathSegments.length; depth >= 0; depth -= 1) {
    const offset = findJsonPathOffset(rawDraft, pathSegments.slice(0, depth));
    if (offset !== null) {
      return toLineAndColumn(rawDraft, offset);
    }
  }

  return null;
};
