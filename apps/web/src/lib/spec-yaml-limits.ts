export const MAX_YAML_INPUT_BYTES = 256 * 1024;
export const MAX_YAML_LINES = 5_000;
export const MAX_YAML_ALIASES = 10;
export const MAX_EXPANDED_SPEC_BYTES = 1024 * 1024;
export const MAX_EXPANDED_NODES = 20_000;
export const MAX_EXPANDED_DEPTH = 40;
export const MAX_YAML_CPU_MS = 200;
export const YAML_WORKER_TIMEOUT_MS = 250;

export type YamlFailureCode =
  | "input_size"
  | "line_count"
  | "alias_count"
  | "cpu_limit"
  | "parse_failed"
  | "root_type"
  | "expanded_size"
  | "node_count"
  | "depth"
  | "unsupported_value";

export const YAML_ERROR_MESSAGES: Record<YamlFailureCode, string> = {
  input_size: "YAML input exceeds safe size limit",
  line_count: "YAML input has too many lines",
  alias_count: "YAML aliases exceed safe complexity limit",
  cpu_limit: "YAML conversion exceeded safe processing limit",
  parse_failed: "Could not parse as JSON or YAML",
  root_type: "YAML root must be an object",
  expanded_size: "Expanded YAML exceeds safe size limit",
  node_count: "Expanded YAML exceeds safe complexity limit",
  depth: "Expanded YAML exceeds safe complexity limit",
  unsupported_value: "YAML contains an unsupported value",
};
