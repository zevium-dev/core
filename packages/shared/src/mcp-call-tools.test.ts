import { describe, expect, it } from "vitest";
import { callApiTool } from "./mcp-call-tools.js";

describe("callApiTool", () => {
  it("routes only GET/HEAD to the read tool", () => {
    for (const method of ["GET", "head", "Get"])
      expect(callApiTool(method)).toBe("call_api_read");
    for (const method of ["POST", "put", "PATCH", "DELETE", "OPTIONS", "TRACE"])
      expect(callApiTool(method)).toBe("call_api_write");
    for (const method of ["", "CONNECT", "PROPFIND", "GET "])
      expect(callApiTool(method)).toBeNull();
  });
});
