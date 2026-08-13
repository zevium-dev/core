import {
  ASSET_HASH_PATTERN,
  isSafeModuleName,
  type WorkerMigrationIntent,
  validateWorkerMetadata,
} from "./api-policy";
import { BrokerError, invariant } from "./errors";
import { sha256Hex, timingSafeEqual } from "./crypto";
import type { TargetManifest } from "./manifest";
import { isRecord, parseStrictJson } from "./strict-json";

const HEADER_TERMINATOR = new Uint8Array([13, 10, 13, 10]);
const CRLF = new Uint8Array([13, 10]);
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_SIGNED_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_PARTS = 2_000;
const WORKER_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/javascript+module",
  "application/octet-stream",
  "application/python",
  "application/source-map",
  "application/wasm",
  "text/plain",
]);

interface PartHeaders {
  contentType: string | undefined;
  filename: string | undefined;
  name: string;
}

interface MultipartInspectorOptions {
  assetContentTypes?: Record<string, string>;
  assetDigests?: Record<string, string>;
  assetSizes?: Record<string, number>;
  mode: "assets" | "worker-version";
  target: TargetManifest;
}

export interface InspectedMultipart {
  assetHashes?: string[];
  assetsJwt?: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  mainModule?: string;
  migrationIntent?: WorkerMigrationIntent | null;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0) return 0;
  outer: for (
    let index = 0;
    index <= haystack.byteLength - needle.byteLength;
    index += 1
  ) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function ascii(bytes: Uint8Array, label: string): string {
  for (const byte of bytes) {
    if ((byte < 0x20 && byte !== 0x0d && byte !== 0x0a) || byte > 0x7e) {
      throw new BrokerError(
        400,
        "multipart_rejected",
        `${label} must be printable ASCII`,
      );
    }
  }
  return new TextDecoder().decode(bytes);
}

function parseHeaders(bytes: Uint8Array): PartHeaders {
  const source = ascii(bytes, "Multipart headers");
  const headers = new Map<string, string>();
  const lines = source.split("\r\n");
  invariant(
    lines.length <= 16,
    400,
    "multipart_rejected",
    "Multipart has too many headers",
  );
  for (const line of lines) {
    const separator = line.indexOf(":");
    invariant(
      separator > 0,
      400,
      "multipart_rejected",
      "Multipart header is invalid",
    );
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    invariant(
      /^[a-z-]+$/.test(name) && !headers.has(name),
      400,
      "multipart_rejected",
      "Multipart header is duplicate or invalid",
    );
    headers.set(name, value);
  }
  invariant(
    [...headers.keys()].every(
      (name) => name === "content-disposition" || name === "content-type",
    ),
    400,
    "multipart_rejected",
    "Multipart header is not allowed",
  );
  const disposition = headers.get("content-disposition") ?? "";
  const match = /^form-data; name="([^"]+)"(?:; filename="([^"]+)")?$/.exec(
    disposition,
  );
  invariant(
    match,
    400,
    "multipart_rejected",
    "Multipart disposition is invalid",
  );
  const name = match[1] ?? "";
  const filename = match[2];
  return {
    contentType: headers.get("content-type"),
    filename,
    name,
  };
}

class StreamingMultipartInspector {
  private buffer = new Uint8Array();
  private collectedMetadata: Uint8Array[] = [];
  private currentBodyBytes = 0;
  private currentHeaders: PartHeaders | undefined;
  private done = false;
  private currentBase64Characters = 0;
  private currentBase64Padding = 0;
  private metadataBytes = 0;
  private partCount = 0;
  private readonly partHeaders: PartHeaders[] = [];
  private readonly delimiter: Uint8Array;
  private readonly initial: Uint8Array;
  private readonly seenNames = new Set<string>();
  private readonly partChunks = new Map<string, Uint8Array[]>();
  private readonly partSizes = new Map<string, number>();
  private secretBindings: Array<{ name: string; text: string }> = [];
  private collectedArtifactBytes = 0;
  private state: "body" | "boundary" | "finished" | "headers" | "start" =
    "start";
  mainModule: string | undefined;
  migrationIntent: WorkerMigrationIntent | null | undefined;
  assetsJwt: string | undefined;
  readonly assetHashes: string[] = [];
  ready = false;

  constructor(
    boundary: string,
    private readonly options: MultipartInspectorOptions,
  ) {
    this.initial = new TextEncoder().encode(`--${boundary}\r\n`);
    this.delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  }

  feed(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);
    this.process();
  }

  finish(): void {
    this.process();
    invariant(
      this.done,
      400,
      "multipart_rejected",
      "Multipart final boundary is missing",
    );
    invariant(
      this.buffer.byteLength === 0 ||
        (this.buffer.byteLength === 2 && indexOf(this.buffer, CRLF) === 0),
      400,
      "multipart_rejected",
      "Multipart has data after final boundary",
    );
    if (this.options.mode !== "assets") {
      invariant(
        this.mainModule !== undefined && this.seenNames.has(this.mainModule),
        400,
        "multipart_rejected",
        "Worker main module part is missing",
      );
      const expected = this.options.target.modules.map((module) => module.name);
      const actual = [...this.seenNames].filter((name) => name !== "metadata");
      invariant(
        actual.length === expected.length &&
          actual.every((name) => expected.includes(name)),
        400,
        "artifact_rejected",
        "Worker module set does not match signed manifest",
      );
    }
  }

  async verifyArtifacts(): Promise<void> {
    for (const binding of this.secretBindings) {
      const expected = this.options.target.allowedSecrets.find(
        (secret) => secret.name === binding.name,
      );
      invariant(
        expected !== undefined &&
          timingSafeEqual(await sha256Hex(binding.text), expected.sha256),
        400,
        "secret_rejected",
        `Secret ${binding.name} does not match signed manifest`,
      );
    }
    if (this.options.mode === "worker-version") {
      for (const expected of this.options.target.modules) {
        const bytes = this.partBytes(expected.name);
        invariant(
          bytes.byteLength === expected.size &&
            timingSafeEqual(await sha256Hex(bytes), expected.sha256),
          400,
          "artifact_rejected",
          `Worker module ${expected.name} does not match signed manifest`,
        );
      }
      return;
    }
    for (const [hash, expectedSha256] of Object.entries(
      this.options.assetDigests ?? {},
    )) {
      if (!this.seenNames.has(hash)) continue;
      const encoded = this.partBytes(hash);
      const size = this.options.assetSizes?.[hash];
      invariant(
        size !== undefined,
        500,
        "artifact_state_invalid",
        "Static asset size is missing from session",
      );
      const bytes = decodeBase64(encoded, size);
      invariant(
        timingSafeEqual(await sha256Hex(bytes), expectedSha256),
        400,
        "artifact_rejected",
        `Static asset ${hash} does not match signed manifest`,
      );
    }
  }

  forwardedBody(boundary: string): {
    body: ReadableStream<Uint8Array>;
    contentLength: number;
  } {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const [index, headers] of this.partHeaders.entries()) {
      const disposition =
        `Content-Disposition: form-data; name="${headers.name}"` +
        (headers.filename === undefined
          ? ""
          : `; filename="${headers.filename}"`);
      const header = [
        `${index === 0 ? "" : "\r\n"}--${boundary}`,
        disposition,
        ...(headers.contentType === undefined
          ? []
          : [`Content-Type: ${headers.contentType}`]),
        "",
        "",
      ].join("\r\n");
      chunks.push(encoder.encode(header));
      chunks.push(
        ...(headers.name === "metadata"
          ? this.collectedMetadata
          : (this.partChunks.get(headers.name) ?? [])),
      );
    }
    chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
    const contentLength = chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
    let index = 0;
    return {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          index += 1;
          controller.enqueue(chunk);
        },
      }),
      contentLength,
    };
  }

  private partBytes(name: string): Uint8Array {
    const chunks = this.partChunks.get(name) ?? [];
    const bytes = new Uint8Array(this.partSizes.get(name) ?? 0);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private process(): void {
    for (;;) {
      if (this.state === "start") {
        if (this.buffer.byteLength < this.initial.byteLength) return;
        invariant(
          indexOf(
            this.buffer.slice(0, this.initial.byteLength),
            this.initial,
          ) === 0,
          400,
          "multipart_rejected",
          "Multipart preamble is invalid",
        );
        this.buffer = this.buffer.slice(this.initial.byteLength);
        this.state = "headers";
      }

      if (this.state === "headers") {
        const end = indexOf(this.buffer, HEADER_TERMINATOR);
        if (end < 0) {
          invariant(
            this.buffer.byteLength <= MAX_HEADER_BYTES,
            400,
            "multipart_rejected",
            "Multipart headers are too large",
          );
          return;
        }
        const headers = parseHeaders(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + HEADER_TERMINATOR.byteLength);
        this.beginPart(headers);
        this.state = "body";
      }

      if (this.state === "body") {
        const boundaryIndex = indexOf(this.buffer, this.delimiter);
        if (boundaryIndex < 0) {
          const retained = Math.min(
            this.buffer.byteLength,
            this.delimiter.byteLength + 4,
          );
          const consumed = this.buffer.byteLength - retained;
          if (consumed > 0) {
            this.addBody(this.buffer.slice(0, consumed));
            this.buffer = this.buffer.slice(consumed);
          }
          return;
        }
        this.addBody(this.buffer.slice(0, boundaryIndex));
        this.buffer = this.buffer.slice(
          boundaryIndex + this.delimiter.byteLength,
        );
        this.endPart();
        this.state = "boundary";
      }

      if (this.state === "boundary") {
        if (this.buffer.byteLength < 2) return;
        if (this.buffer[0] === 45 && this.buffer[1] === 45) {
          this.buffer = this.buffer.slice(2);
          this.done = true;
          this.state = "finished";
          continue;
        }
        invariant(
          this.buffer[0] === 13 && this.buffer[1] === 10,
          400,
          "multipart_rejected",
          "Multipart boundary suffix is invalid",
        );
        this.buffer = this.buffer.slice(2);
        this.state = "headers";
      }

      if (this.state === "finished") {
        invariant(
          this.buffer.byteLength <= CRLF.byteLength &&
            [...this.buffer].every((byte, index) => byte === CRLF[index]),
          400,
          "multipart_rejected",
          "Multipart has data after final boundary",
        );
        return;
      }
    }
  }

  private beginPart(headers: PartHeaders): void {
    this.partCount += 1;
    invariant(
      this.partCount <= MAX_PARTS,
      400,
      "multipart_rejected",
      "Multipart has too many parts",
    );
    invariant(
      !this.seenNames.has(headers.name),
      400,
      "multipart_rejected",
      "Multipart part is duplicate",
    );
    this.seenNames.add(headers.name);
    this.partHeaders.push(headers);
    this.currentHeaders = headers;
    this.currentBodyBytes = 0;
    this.currentBase64Characters = 0;
    this.currentBase64Padding = 0;

    if (this.options.mode !== "assets" && this.partCount === 1) {
      invariant(
        headers.name === "metadata" && headers.filename === undefined,
        400,
        "multipart_rejected",
        "Worker metadata must be first multipart part",
      );
      invariant(
        headers.contentType === undefined ||
          headers.contentType === "application/json",
        400,
        "multipart_rejected",
        "Worker metadata content type is invalid",
      );
      return;
    }

    invariant(
      headers.name !== "metadata",
      400,
      "multipart_rejected",
      "Duplicate metadata part was rejected",
    );
    if (this.options.mode === "assets") {
      invariant(
        ASSET_HASH_PATTERN.test(headers.name) &&
          headers.filename === headers.name &&
          this.options.assetSizes?.[headers.name] !== undefined &&
          headers.contentType ===
            this.options.assetContentTypes?.[headers.name],
        400,
        "asset_rejected",
        "Asset part is not declared in manifest",
      );
      this.assetHashes.push(headers.name);
      this.ready = true;
      this.partChunks.set(headers.name, []);
      this.partSizes.set(headers.name, 0);
      return;
    }
    invariant(
      isSafeModuleName(headers.name) &&
        headers.filename === headers.name &&
        headers.contentType !== undefined &&
        WORKER_CONTENT_TYPES.has(headers.contentType),
      400,
      "multipart_rejected",
      "Worker module part is invalid",
    );
    const expected = this.options.target.modules.find(
      (module) => module.name === headers.name,
    );
    invariant(
      expected !== undefined && expected.contentType === headers.contentType,
      400,
      "artifact_rejected",
      "Worker module is not declared in signed manifest",
    );
    this.partChunks.set(headers.name, []);
    this.partSizes.set(headers.name, 0);
  }

  private addBody(bytes: Uint8Array): void {
    this.currentBodyBytes += bytes.byteLength;
    const headers = this.currentHeaders;
    invariant(
      headers,
      400,
      "multipart_rejected",
      "Multipart parser lost part state",
    );
    if (headers.name === "metadata") {
      this.metadataBytes += bytes.byteLength;
      invariant(
        this.metadataBytes <= MAX_METADATA_BYTES,
        413,
        "metadata_too_large",
        "Worker metadata is too large",
      );
      this.collectedMetadata.push(bytes);
      return;
    }
    this.partChunks.get(headers.name)?.push(bytes);
    this.collectedArtifactBytes += bytes.byteLength;
    invariant(
      this.collectedArtifactBytes <= MAX_SIGNED_ARTIFACT_BYTES,
      413,
      "artifact_too_large",
      "Signed artifact verification buffer is too large",
    );
    this.partSizes.set(
      headers.name,
      (this.partSizes.get(headers.name) ?? 0) + bytes.byteLength,
    );
    if (this.options.mode === "assets") {
      for (const byte of bytes) {
        if (byte === 61) {
          this.currentBase64Padding += 1;
          invariant(
            this.currentBase64Padding <= 2,
            400,
            "asset_rejected",
            "Bulk asset base64 padding is invalid",
          );
        } else {
          invariant(
            this.currentBase64Padding === 0,
            400,
            "asset_rejected",
            "Bulk asset base64 padding is invalid",
          );
        }
        invariant(
          (byte >= 65 && byte <= 90) ||
            (byte >= 97 && byte <= 122) ||
            (byte >= 48 && byte <= 57) ||
            byte === 43 ||
            byte === 47 ||
            byte === 61,
          400,
          "asset_rejected",
          "Bulk asset body is not base64",
        );
        this.currentBase64Characters += 1;
      }
    }
  }

  private endPart(): void {
    const headers = this.currentHeaders;
    invariant(
      headers,
      400,
      "multipart_rejected",
      "Multipart parser lost part state",
    );
    if (headers.name === "metadata") {
      const bytes = new Uint8Array(this.metadataBytes);
      let offset = 0;
      for (const chunk of this.collectedMetadata) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new BrokerError(
          400,
          "metadata_rejected",
          "Worker metadata is not UTF-8",
        );
      }
      const metadata = parseStrictJson(source);
      const result = validateWorkerMetadata(
        metadata,
        this.options.target,
        "version",
      );
      this.mainModule = result.mainModule;
      this.migrationIntent = result.migrationIntent;
      this.assetsJwt = result.assetsJwt;
      this.secretBindings = result.secretBindings ?? [];
      this.ready = true;
    } else if (this.options.mode === "assets") {
      const size = this.options.assetSizes?.[headers.name];
      invariant(
        size !== undefined,
        400,
        "asset_rejected",
        "Asset is not declared",
      );
      const expectedBase64Bytes = 4 * Math.ceil(size / 3);
      const expectedPadding = size === 0 ? 0 : (3 - (size % 3)) % 3;
      invariant(
        this.currentBodyBytes === expectedBase64Bytes &&
          this.currentBase64Characters % 4 === 0 &&
          this.currentBase64Padding === expectedPadding,
        400,
        "asset_rejected",
        "Bulk asset size does not match declared manifest",
      );
    }
    this.currentHeaders = undefined;
    this.currentBodyBytes = 0;
    this.currentBase64Characters = 0;
    this.currentBase64Padding = 0;
  }
}

function decodeBase64(source: Uint8Array, expectedBytes: number): Uint8Array {
  const output = new Uint8Array(expectedBytes);
  const value = (byte: number): number => {
    if (byte >= 65 && byte <= 90) return byte - 65;
    if (byte >= 97 && byte <= 122) return byte - 71;
    if (byte >= 48 && byte <= 57) return byte + 4;
    if (byte === 43) return 62;
    if (byte === 47) return 63;
    return 0;
  };
  let offset = 0;
  for (let index = 0; index < source.byteLength; index += 4) {
    const left = value(source[index] ?? 61);
    const middleLeft = value(source[index + 1] ?? 61);
    const middleRight = value(source[index + 2] ?? 61);
    const right = value(source[index + 3] ?? 61);
    if (offset < output.length)
      output[offset++] = (left << 2) | (middleLeft >> 4);
    if (offset < output.length) {
      output[offset++] = ((middleLeft & 15) << 4) | (middleRight >> 2);
    }
    if (offset < output.length)
      output[offset++] = ((middleRight & 3) << 6) | right;
  }
  invariant(
    offset === expectedBytes,
    400,
    "artifact_rejected",
    "Static asset decoded length does not match signed manifest",
  );
  return output;
}

function parseBoundary(contentType: string | null): string {
  invariant(
    contentType,
    415,
    "invalid_content_type",
    "Multipart Content-Type is required",
  );
  const match =
    /^multipart\/form-data; boundary=([A-Za-z0-9'()+_,./:=?-]{1,70})$/.exec(
      contentType,
    );
  invariant(
    match,
    415,
    "invalid_content_type",
    "Multipart boundary is invalid",
  );
  return match[1] ?? "";
}

function parseContentLength(
  request: Request,
  maximumBytes: number,
): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  invariant(
    /^[1-9][0-9]*$/.test(raw),
    400,
    "invalid_content_length",
    "Content-Length is invalid",
  );
  const value = Number(raw);
  invariant(
    value <= maximumBytes,
    413,
    "body_too_large",
    "Multipart body exceeds route limit",
  );
  return value;
}

export async function inspectMultipart(
  request: Request,
  options: MultipartInspectorOptions,
  maximumBytes: number,
): Promise<InspectedMultipart> {
  invariant(
    request.body,
    400,
    "multipart_rejected",
    "Multipart body is required",
  );
  const boundary = parseBoundary(request.headers.get("content-type"));
  const contentLength = parseContentLength(request, maximumBytes);
  const reader = request.body.getReader();
  const parser = new StreamingMultipartInspector(boundary, options);
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    invariant(
      total <= maximumBytes,
      413,
      "body_too_large",
      "Multipart body exceeds route limit",
    );
    parser.feed(result.value);
  }
  parser.finish();
  invariant(
    contentLength === null || total === contentLength,
    400,
    "invalid_content_length",
    "Content-Length did not match body",
  );
  await parser.verifyArtifacts();
  const forwarded = parser.forwardedBody(boundary);
  return {
    ...(parser.assetHashes.length > 0
      ? { assetHashes: parser.assetHashes }
      : {}),
    ...(parser.assetsJwt ? { assetsJwt: parser.assetsJwt } : {}),
    body: forwarded.body,
    contentLength: forwarded.contentLength,
    ...(parser.mainModule ? { mainModule: parser.mainModule } : {}),
    ...(parser.migrationIntent === undefined
      ? {}
      : { migrationIntent: parser.migrationIntent }),
  };
}

export function validateSingleAssetLength(
  contentLength: number | null,
  expectedSize: number | undefined,
): void {
  invariant(
    expectedSize !== undefined,
    400,
    "asset_rejected",
    "Asset is not declared in session",
  );
  invariant(
    contentLength === null || contentLength === expectedSize,
    400,
    "asset_rejected",
    "Asset size does not match declared manifest",
  );
}

export function isValidatedAssetState(
  value: unknown,
): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([hash, size]) =>
        ASSET_HASH_PATTERN.test(hash) &&
        typeof size === "number" &&
        Number.isSafeInteger(size) &&
        size >= 0,
    )
  );
}
