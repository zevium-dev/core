import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("package.json", packageRoot), "utf8"),
);
const minimumNode = manifest.engines.node.replace(/^>=/, "");

export async function buildCli() {
  const output = new URL("dist/zevium.mjs", packageRoot);
  const result = await build({
    absWorkingDir: fileURLToPath(packageRoot),
    // Keep entry exports/top-level await out of the artifact so a download
    // renamed to extensionless `zevium` also runs inside CommonJS projects.
    stdin: {
      contents: 'import { main } from "./src/main.ts"; void main();',
      resolveDir: fileURLToPath(packageRoot),
      sourcefile: "cli-entry.mjs",
      loader: "js",
    },
    outfile: fileURLToPath(output),
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${minimumNode}`,
    metafile: true,
    // Runs before bundled dependency initialization, including on older Node.
    banner: {
      js: `#!/usr/bin/env node
const requiredNode = ${JSON.stringify(minimumNode.split(".").map(Number))};
const actualNode = process.versions.node.split(".").map(Number);
const differentPart = requiredNode.findIndex((part, index) => part !== actualNode[index]);
if (differentPart !== -1 && actualNode[differentPart] < requiredNode[differentPart]) {
  process.stderr.write("zevium: Node.js ${minimumNode} or newer is required; found " + process.versions.node + ".\\n");
  process.exit(1);
}`,
    },
  });
  for (const artifact of Object.values(result.metafile.outputs)) {
    if (artifact.imports.some((entry) => !entry.path.startsWith("node:"))) {
      throw new Error("CLI bundle must not import runtime dependencies");
    }
  }
  await chmod(output, 0o755);
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildCli();
