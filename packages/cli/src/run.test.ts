import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSpecContract } from "@zevium/shared";
import { representativeSpec } from "../../shared/src/spec-generation/fixture.js";
import { runCli } from "./run.js";
import { main } from "./main.js";
import { terminalText } from "./terminal.js";
const terminalPayload =
  "before\u001b[2J\u001b]52;c;Y2xpcGJvYXJk\u0007\u009b31m\u009d52;c;eA==\u009c\u001b]8;;https://evil.invalid\u001b\\link\u001b]8;;\u001b\\\u202ereversed\u202c\u2066isolate\u2069\rafter\b\u0000";

const contract = generateSpecContract({
  spec: JSON.stringify(representativeSpec),
  version: "2.0.0",
});
const toolResult = (text: string, isError = false) =>
  Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: { isError, content: [{ type: "text", text }] },
  });
const docs = () =>
  toolResult(JSON.stringify({ publisherData: { generated: contract } }));
const opts = { gatewayUrl: "http://localhost:8787", apiKey: "zev_fixture" };

describe("zevium CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it.each(["docs", "help", "response"])(
    "escapes terminal injection in %s",
    async (surface) => {
      const generated = structuredClone(contract);
      generated.markdown += terminalPayload;
      generated.operations[0]!.tool.description += terminalPayload;
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          toolResult(JSON.stringify({ publisherData: { generated } })),
        )
        .mockResolvedValueOnce(toolResult(terminalPayload));
      const argv =
        surface === "docs"
          ? ["acme", "pets"]
          : surface === "help"
            ? ["acme", "pets", "getpet_1", "--help"]
            : ["acme", "pets", "get_ping_3"];
      const result = await runCli(argv, { ...opts, fetchImpl });
      expect(result).toContain(terminalText(terminalPayload));
      expect(result).not.toContain("\u001b");
      expect(result).not.toContain("\u202e");
    },
  );
  it.each([false, true])(
    "protects actual process output (stderr=%s)",
    async (failure) => {
      vi.spyOn(process, "argv", "get").mockReturnValue([
        "node",
        "zevium",
        "acme",
        "pets",
      ]);
      vi.stubEnv("ZEVIUM_GATEWAY_URL", "http://localhost:8787");
      const previousExitCode = process.exitCode;
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      vi.stubGlobal(
        "fetch",
        failure
          ? vi.fn().mockRejectedValue(new Error(terminalPayload))
          : vi.fn().mockResolvedValue(
              toolResult(
                JSON.stringify({
                  publisherData: {
                    generated: { ...contract, markdown: terminalPayload },
                  },
                }),
              ),
            ),
      );
      try {
        await main();
        expect(failure ? stderr : stdout).toHaveBeenCalledWith(
          `${failure ? "zevium: " : ""}${terminalText(terminalPayload)}\n`,
        );
        expect(failure ? stdout : stderr).not.toHaveBeenCalled();
        if (failure) expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );
  it("loads docs and help without executing or requiring a key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => docs());
    expect(await runCli(["acme", "pets"], { fetchImpl })).toBe(
      contract.markdown,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      await runCli(["acme", "pets", "getpet_1", "--help"], { fetchImpl }),
    ).toContain("Cost: 3 credits");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("executes generated GET flags solely through authenticated MCP call_api_read", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(docs())
      .mockResolvedValueOnce(toolResult('{"status":200,"cost":3}'));
    expect(
      await runCli(
        [
          "acme",
          "pets",
          "getpet_1",
          "--path-id",
          "a/b",
          "--query-tags",
          '["a","b"]',
        ],
        { ...opts, fetchImpl },
      ),
    ).toContain('"cost":3');
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe("http://localhost:8787/mcp");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer zev_fixture",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      params: {
        name: "call_api_read",
        arguments: {
          org: "acme",
          project: "pets",
          method: "GET",
          path: "/pets/{id}",
          pathParams: { id: "a/b" },
          query: { tags: ["a", "b"] },
        },
      },
    });
    expect(
      fetchImpl.mock.calls.every(([target]) => String(target).endsWith("/mcp")),
    ).toBe(true);
  });
  it("sends JSON bodies with the generated media type", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(docs())
      .mockResolvedValueOnce(toolResult("ok"));
    await runCli(
      [
        "acme",
        "pets",
        "getpet_2",
        "--path-id",
        "one",
        "--body",
        '{"name":"cat"}',
      ],
      { ...opts, fetchImpl },
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toMatchObject(
      {
        params: {
          name: "call_api_write",
          arguments: {
            body: { name: "cat" },
            headers: { "content-type": "application/json" },
          },
        },
      },
    );
  });
  it.each([
    [["acme", "pets", "getpet_1"], "Missing required flag"],
    [["acme", "pets", "unknown"], "Unknown or unsupported"],
    [
      ["acme", "pets", "getpet_1", "--path-id", "one", "--query-limit", "oops"],
      "valid JSON",
    ],
  ])("rejects invalid input before execution", async (argv, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(docs());
    await expect(runCli(argv, { ...opts, fetchImpl })).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("requires an execution key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(docs());
    await expect(
      runCli(["acme", "pets", "get_ping_3"], { fetchImpl }),
    ).rejects.toThrow("ZEVIUM_API_KEY");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("reports MCP failures and never retries paid execution", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(docs())
      .mockResolvedValueOnce(toolResult("private diagnostic", true));
    await expect(
      runCli(["acme", "pets", "get_ping_3"], { ...opts, fetchImpl }),
    ).rejects.toThrow("Gateway rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rejects insecure remote origins and embedded credentials before sending auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const gatewayUrl of [
      "http://remote.invalid",
      "https://user:secret@example.com",
      "https://gateway.zevium.dev/other",
    ])
      await expect(
        runCli(["acme", "pets"], { ...opts, gatewayUrl, fetchImpl }),
      ).rejects.toThrow("HTTPS origin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("loads docs for contracts with unsupported-operation diagnostics", async () => {
    const withDiagnostics = generateSpecContract({
      spec: JSON.stringify({
        ...representativeSpec,
        paths: {
          ...representativeSpec.paths,
          "/session": {
            get: {
              "x-zevium-cost": 1,
              parameters: [
                { name: "sid", in: "cookie", schema: { type: "string" } },
              ],
            },
          },
        },
      }),
      version: "2.0.0",
    });
    expect(withDiagnostics.diagnostics).toEqual([
      { identity: "GET /session", code: "unsupported_parameter_location" },
    ]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        toolResult(
          JSON.stringify({ publisherData: { generated: withDiagnostics } }),
        ),
      );
    expect(await runCli(["acme", "pets"], { fetchImpl })).toContain(
      "unsupported_parameter_location",
    );
  });
  it.each([0, 1, 3, 9000, -1, 1.1])(
    "rejects unsupported numeric generator major %s before call_api_*",
    async (generatorVersion) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
        toolResult(
          JSON.stringify({
            publisherData: { generated: { ...contract, generatorVersion } },
          }),
        ),
      );
      await expect(
        runCli(["acme", "pets", "get_ping_3"], { ...opts, fetchImpl }),
      ).rejects.toThrow(
        `listing uses generator major ${generatorVersion}; this CLI supports 2; download the latest CLI`,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["response_size_limit", "complexity_limit"])(
    "reports unavailable generation (%s) without an upgrade prompt",
    async (reason) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
        toolResult(
          JSON.stringify({
            publisherData: {
              generated: { error: "generation_unavailable", reason },
            },
          }),
        ),
      );
      await expect(
        runCli(["acme", "pets", "get_ping_3"], { ...opts, fetchImpl }),
      ).rejects.toThrow(
        `generated contract unavailable for this listing (${reason}); read the listing Markdown`,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ...["2", "1.0.0", null, undefined].map((generatorVersion) => ({
      publisherData: { generated: { ...contract, generatorVersion } },
    })),
    {},
    { publisherData: { generated: null } },
    { publisherData: { generated: { ...contract, operations: null } } },
  ])("reports malformed contracts without an upgrade prompt", async (raw) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(toolResult(JSON.stringify(raw)));
    await expect(
      runCli(["acme", "pets", "get_ping_3"], { ...opts, fetchImpl }),
    ).rejects.toThrow(/^invalid contract$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a generated call whose tool does not match its method", async () => {
    const generated = structuredClone(contract);
    const get = generated.operations.find((op) => op.method === "GET")!;
    get.call.tool = "call_api_write";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        toolResult(JSON.stringify({ publisherData: { generated } })),
      );
    await expect(
      runCli(["acme", "pets", get.command.name], { ...opts, fetchImpl }),
    ).rejects.toThrow(/^invalid contract$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("accepts additive fields within supported major 2", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        toolResult(
          JSON.stringify({
            publisherData: {
              generated: {
                ...contract,
                generatorVersion: 2,
                futureOptionalField: true,
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(toolResult("ok"));
    expect(
      await runCli(["acme", "pets", "get_ping_3"], { ...opts, fetchImpl }),
    ).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("bounds streamed responses and rejects stale generator formats", async () => {
    await expect(
      runCli(["acme", "pets"], {
        fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
      }),
    ).rejects.toThrow("1 MiB");
    await expect(
      runCli(["acme", "pets"], {
        fetchImpl: async () =>
          toolResult(
            JSON.stringify({
              publisherData: {
                generated: { ...contract, generatorVersion: 9000 },
              },
            }),
          ),
      }),
    ).rejects.toThrow(
      "listing uses generator major 9000; this CLI supports 2; download the latest CLI",
    );
  });
});
