export function Stats() {
  const items = [
    { label: "developers", value: "10k+" },
    { label: "APIs", value: "500+" },
    { label: "revenue shared", value: "$2M" },
  ];
  return (
    <div className="grid gap-6 sm:grid-cols-3">
      {items.map((s) => (
        <div className="rounded-lg border p-6 text-center" key={s.label}>
          <div className="text-foreground text-3xl font-semibold tracking-tight">{s.value}</div>
          <div className="text-muted-foreground mt-1 text-xs uppercase">{s.label}</div>
        </div>
      ))}
    </div>
  );
}