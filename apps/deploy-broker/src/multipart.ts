import {
  ASSET_HASH_PATTERN,
  isSafeModuleName,
  validateWorkerMetadata,
} from "./api-policy";
import { BrokerError, invariant } from "./errors";
import type { TargetManifest } from "./manifest";
import { isRecord, parseStrictJson } from "./strict-json";

const HEADER_TERMINATOR = new Uint8Array([13, 10, 13, 10]);
const CRLF = new Uint8Array([13, 10]);
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
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
  assetSizes?: Record<string, number>;
  mode: "assets" | "worker-version";
  target: TargetManifest;
}

export interface InspectedMultipart {
  assetsJwt?: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  mainModule?: string;
  migrationMode?: "initial" | "none";
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
  private readonly delimiter: Uint8Array;
  private readonly initial: Uint8Array;
  private readonly seenNames = new Set<string>();
  private state: "body" | "boundary" | "finished" | "headers" | "start" =
    "start";
  mainModule: string | undefined;
  migrationMode: "initial" | "none" | undefined;
  assetsJwt: string | undefined;
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
    }
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
          this.options.assetSizes?.[headers.name] !== undefined,
        400,
        "asset_rejected",
        "Asset part is not declared in manifest",
      );
      this.ready = true;
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
      this.migrationMode = result.migrationMode;
      this.assetsJwt = result.assetsJwt;
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
  const prefix: Uint8Array[] = [];
  let total = 0;

  while (!parser.ready) {
    const result = await reader.read();
    invariant(
      !result.done,
      400,
      "multipart_rejected",
      "Multipart ended before policy metadata",
    );
    total += result.value.byteLength;
    invariant(
      total <= maximumBytes,
      413,
      "body_too_large",
      "Multipart body exceeds route limit",
    );
    invariant(
      total <= MAX_METADATA_BYTES + MAX_HEADER_BYTES * 2,
      413,
      "metadata_too_large",
      "Multipart policy prefix is too large",
    );
    parser.feed(result.value);
    prefix.push(result.value);
  }

  let prefixIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (prefixIndex < prefix.length) {
          const chunk = prefix[prefixIndex];
          prefixIndex += 1;
          if (chunk) controller.enqueue(chunk);
          return;
        }
        const result = await reader.read();
        if (result.done) {
          parser.finish();
          if (contentLength !== null) {
            invariant(
              total === contentLength,
              400,
              "invalid_content_length",
              "Content-Length did not match body",
            );
          }
          controller.close();
          return;
        }
        total += result.value.byteLength;
        invariant(
          total <= maximumBytes,
          413,
          "body_too_large",
          "Multipart body exceeds route limit",
        );
        parser.feed(result.value);
        controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel("multipart validation failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return {
    ...(parser.assetsJwt ? { assetsJwt: parser.assetsJwt } : {}),
    body,
    contentLength,
    ...(parser.mainModule ? { mainModule: parser.mainModule } : {}),
    ...(parser.migrationMode ? { migrationMode: parser.migrationMode } : {}),
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
