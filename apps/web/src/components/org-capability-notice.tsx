export function OrgCapabilityNotice({ reason }: { reason: string | null }) {
  if (reason === null) return null;

  return (
    <p
      role="note"
      className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
    >
      {reason}
    </p>
  );
}
