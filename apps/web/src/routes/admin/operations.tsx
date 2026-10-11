import { createFileRoute } from "@tanstack/react-router";
import { OperatorConsole } from "#/components/operator-console";
export const Route = createFileRoute("/admin/operations")({
  component: OperatorConsole,
});
