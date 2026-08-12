/**
 * Apply production-only env values over any dev values inherited from the
 * calling shell. Client and server Clerk keys must always name one instance.
 */
export function applyProductionEnv(target, source = "") {
  for (const line of source.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const name = line.slice(0, separator);
    const rawValue = line.slice(separator + 1);
    target[name] =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? JSON.parse(rawValue)
        : rawValue;
  }

  // Clerk's browser SDK reads VITE_CLERK_PUBLISHABLE_KEY while middleware
  // reads CLERK_PUBLISHABLE_KEY. Never allow a sourced dev VITE key to pair
  // with production middleware and Convex.
  if (target.CLERK_PUBLISHABLE_KEY) {
    target.VITE_CLERK_PUBLISHABLE_KEY = target.CLERK_PUBLISHABLE_KEY;
  }

  return target;
}
