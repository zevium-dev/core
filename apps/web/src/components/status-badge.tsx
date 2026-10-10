import { Badge } from "#/components/ui/badge";

export function StatusBadge({ status }: { status: number }) {
  const variant =
    status >= 200 && status < 400
      ? "secondary"
      : status >= 400 && status < 500
        ? "outline"
        : "destructive";
  return <Badge variant={variant}>{status}</Badge>;
}
