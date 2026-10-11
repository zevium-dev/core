import { createFileRoute } from "@tanstack/react-router";
import { OperatorConsole } from "#/components/operator-console";
import { NEXT_CONTROL_PLANE } from "#/lib/control-plane";
export const Route = createFileRoute("/admin/operations")({
  component: Operations,
});
function Operations() {
  return NEXT_CONTROL_PLANE ? (
    <OperatorConsole />
  ) : (
    <p>
      Operator exceptions are available in the replacement control-plane
      preview.
    </p>
  );
}
