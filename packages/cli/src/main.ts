import { runCli } from "./run.js";
import { terminalText } from "./terminal.js";

export async function main() {
  try {
    const result = await runCli(process.argv.slice(2), {
      gatewayUrl: process.env.ZEVIUM_GATEWAY_URL,
      apiKey: process.env.ZEVIUM_API_KEY,
    });
    process.stdout.write(
      terminalText(result) + (result.endsWith("\n") ? "" : "\n"),
    );
  } catch (error) {
    // Native fetch errors can contain network internals; expose only curated messages.
    const message =
      error instanceof Error &&
      !(error instanceof TypeError) &&
      error.name !== "TimeoutError"
        ? error.message
        : "Gateway unavailable; check configuration and retry";
    process.stderr.write(`zevium: ${terminalText(message)}\n`);
    process.exitCode = 1;
  }
}
