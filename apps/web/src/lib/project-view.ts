import type { FunctionReturnType } from "convex/server";
import type { api } from "./convex-api";
export type ProjectView = NonNullable<
  FunctionReturnType<typeof api.projects.get>
>;
