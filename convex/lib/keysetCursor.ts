const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBytes(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const packed =
      (first << 16) | ((second ?? 0) << 8) | (third === undefined ? 0 : third);
    output += BASE64URL_ALPHABET[(packed >>> 18) & 63];
    output += BASE64URL_ALPHABET[(packed >>> 12) & 63];
    if (second !== undefined) output += BASE64URL_ALPHABET[(packed >>> 6) & 63];
    if (third !== undefined) output += BASE64URL_ALPHABET[packed & 63];
  }
  return output;
}

function decodeBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    let packed = 0;
    for (const character of chunk) {
      const digit = BASE64URL_ALPHABET.indexOf(character);
      if (digit < 0) throw new Error("Invalid cursor");
      packed = (packed << 6) | digit;
    }
    packed <<= (4 - chunk.length) * 6;
    bytes.push((packed >>> 16) & 255);
    if (chunk.length >= 3) bytes.push((packed >>> 8) & 255);
    if (chunk.length === 4) bytes.push(packed & 255);
  }
  return new Uint8Array(bytes);
}

export function encodeKeysetCursor(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeKeysetCursor<T>(cursor: string): T {
  if (cursor.length === 0 || cursor.length > 4_096) {
    throw new Error("Invalid cursor");
  }
  try {
    return JSON.parse(new TextDecoder().decode(decodeBytes(cursor))) as T;
  } catch {
    throw new Error("Invalid cursor");
  }
}
