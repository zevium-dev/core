import {
  CALL_API_READ,
  CALL_API_WRITE,
  callApiTool,
  generatedCallArguments,
  type GeneratedOperation,
  isValidSlug,
} from "@zevium/shared";
import { z } from "zod";
import { terminalText } from "./terminal.js";

// This is a reviewed client compatibility pin, not the producer's latest version.
const SUPPORTED_GENERATOR_MAJOR = 2;

const LIMIT = 1024 * 1024;
const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);
const operationSchema = z.object({
  responses: z.record(z.string(), z.unknown()),
  identity: z.string(),
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  credits: z.number(),
  freeTier: z.number().optional(),
  tool: z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  }),
  command: z.object({
    name: z.string(),
    flags: z.array(
      z.object({
        flag: z.string(),
        location: z.enum(["pathParams", "query", "headers", "body"]),
        name: z.string(),
        required: z.boolean(),
        encoding: z.enum(["string", "json"]),
        schema: jsonSchema,
      }),
    ),
  }),
  call: z
    .object({
      tool: z.enum([CALL_API_READ, CALL_API_WRITE]),
      method: z.enum([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "HEAD",
        "TRACE",
      ]),
      path: z.string().startsWith("/"),
      headers: z.record(z.string(), z.string()).optional(),
    })
    // A write method must never be sent through the read tool, or vice versa.
    .refine((call) => callApiTool(call.method) === call.tool),
});
const docsSchema = z.object({
  publisherData: z.object({
    generated: z.object({
      generatorVersion: z.literal(SUPPORTED_GENERATOR_MAJOR),
      version: z.string(),
      markdown: z.string(),
      operations: z.array(operationSchema),
      diagnostics: z.array(
        z.object({ identity: z.string(), code: z.string() }),
      ),
    }),
  }),
});

function endpoint(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/mcp"].includes(url.pathname)
  )
    throw new Error(
      "ZEVIUM_GATEWAY_URL must be an HTTPS origin (HTTP loopback allowed)",
    );
  url.pathname = "/mcp";
  return url;
}

async function readBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty gateway response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMIT)
        throw new Error("Gateway response exceeds 1 MiB limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined)) as unknown;
  } catch {
    throw new Error("Invalid gateway response");
  }
}

const rpcSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .min(1),
  }),
});
export type CliOptions = {
  gatewayUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};
export async function runCli(
  argv: readonly string[],
  options: CliOptions = {},
): Promise<string> {
  return terminalText(await run(argv, options));
}

async function run(
  argv: readonly string[],
  options: CliOptions,
): Promise<string> {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help"))
    return "Usage: zevium <publisher> <project> [command] [--help | generated flags]\nOmit command for generated docs. Set ZEVIUM_API_KEY for execution; ZEVIUM_GATEWAY_URL selects the gateway.\n";
  const [org, project, command, ...flags] = argv;
  if (!org || !project || !isValidSlug(org) || !isValidSlug(project))
    throw new Error("Expected publisher and project slugs");
  const url = endpoint(options.gatewayUrl ?? "https://gateway.zevium.dev");
  const fetchImpl = options.fetchImpl ?? fetch;
  async function rpc(name: string, args: Record<string, unknown>) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (new TextEncoder().encode(body).byteLength > LIMIT)
      throw new Error("Request exceeds 1 MiB limit");
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Gateway HTTP ${response.status}; check gateway URL, key, and credits`,
      );
    }
    const parsed = rpcSchema.safeParse(await readBounded(response));
    if (!parsed.success) throw new Error("Invalid MCP response");
    if (parsed.data.result.isError)
      throw new Error(
        "Gateway rejected the request; check inputs, API key, prepaid balance, and listing availability",
      );
    return parsed.data.result.content.map((c) => c.text).join("\n");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await rpc("get_api_docs", { org, project })) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Invalid generated documentation");
    throw error;
  }
  const docs = docsSchema.safeParse(raw);
  if (!docs.success) {
    const envelope = z
      .object({
        publisherData: z.object({
          generated: z.object({
            error: z.unknown().optional(),
            reason: z.unknown().optional(),
            generatorVersion: z.unknown().optional(),
          }),
        }),
      })
      .safeParse(raw);
    if (envelope.success) {
      const generated = envelope.data.publisherData.generated;
      if (typeof generated.error === "string") {
        const reason =
          typeof generated.reason === "string"
            ? generated.reason
            : generated.error;
        throw new Error(
          `generated contract unavailable for this listing (${reason}); read the listing Markdown`,
        );
      }
      if (
        typeof generated.generatorVersion === "number" &&
        generated.generatorVersion !== SUPPORTED_GENERATOR_MAJOR
      )
        throw new Error(
          `listing uses generator major ${generated.generatorVersion}; this CLI supports ${SUPPORTED_GENERATOR_MAJOR}; download the latest CLI`,
        );
    }
    throw new Error("invalid contract");
  }
  const generated = docs.data.publisherData.generated;
  if (!command || command === "--help") return generated.markdown;
  const operation: GeneratedOperation | undefined = generated.operations.find(
    (op) => op.command.name === command,
  );
  if (!operation)
    throw new Error("Unknown or unsupported command; read listing docs");
  if (flags.length === 1 && flags[0] === "--help")
    return `${operation.tool.description}\n${JSON.stringify(operation.command, null, 2)}\n`;
  if (!options.apiKey)
    throw new Error("Set ZEVIUM_API_KEY before executing a command");
  const args = generatedCallArguments(operation, org, project, flags);
  return await rpc(operation.call.tool, args);
}
