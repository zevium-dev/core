import { deriveSaveStatus } from "#/lib/spec-save-status";
import { useEffect, useState } from "react";
export function SaveStatusLabel(
  props: Omit<Parameters<typeof deriveSaveStatus>[0], "now">,
) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="text-xs text-muted-foreground">
      {deriveSaveStatus({ ...props, now }).label}
    </span>
  );
}
