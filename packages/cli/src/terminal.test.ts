import { describe, expect, it } from "vitest";
import { terminalText } from "./terminal.js";

const terminalPayload =
  "before\u001b[2J\u001b]52;c;Y2xpcGJvYXJk\u0007\u009b31m\u009d52;c;eA==\u009c\u001b]8;;https://evil.invalid\u001b\\link\u001b]8;;\u001b\\\u202ereversed\u202c\u2066isolate\u2069\rafter\b\u0000";

describe("terminal text", () => {
  it("escapes CSI, OSC-52, hyperlinks, C1 and bidi controls as visible text", () => {
    const output = terminalText(terminalPayload);
    expect(output).toContain("\\u001b[2J");
    expect(output).toContain("\\u001b]52;c;Y2xpcGJvYXJk\\u0007");
    expect(output).toContain("\\u009b31m");
    expect(output).toContain("\\u202ereversed\\u202c");
    expect(output).toContain("\\u2066isolate\\u2069");
    expect(output).toContain("\\u000dafter\\u0008\\u0000");
    expect(terminalText(output)).toBe(output);
  });
  it("escapes every C0/C1 control except LF/tab and preserves Unicode prose", () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code >= 0x20 && code < 0x7f) continue;
      const char = String.fromCharCode(code);
      expect(terminalText(char)).toBe(
        code === 9 || code === 10
          ? char
          : `\\u${code.toString(16).padStart(4, "0")}`,
      );
    }
    expect(terminalText("café 中文\n\ttab")).toBe("café 中文\n\ttab");
  });
});
