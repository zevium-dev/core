export function Testimonials() {
  const logos = ["Acme", "ByteLabs", "Nimbus", "Helix", "Orbit", "Pulse"];
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {logos.map((name) => (
        <div
          aria-label={`${name} logo`}
          className="bg-muted/50 text-muted-foreground grid h-20 place-items-center rounded-md border text-sm"
          key={name}
        >
          {name}
        </div>
      ))}
    </div>
  );
}