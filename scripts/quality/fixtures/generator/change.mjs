import { appendFileSync } from "node:fs";

appendFileSync("generated.ts", "export const stale = true;\n");
