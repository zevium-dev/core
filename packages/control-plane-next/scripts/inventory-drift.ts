type FunctionClassification = { name: string; kind: string; status: string };
type RouteClassification = { route: string; method: string; status: string };
type Inventory = {
  functions: FunctionClassification[];
  routes: RouteClassification[];
};

// Source text, inferred types and callers are observations, not frozen CI contracts.
export function inventoryDrift(frozen: Inventory, current: Inventory) {
  const classifications = (inventory: Inventory) => ({
    functions: inventory.functions
      .map(({ name, kind, status }) => ({ name, kind, status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    routes: inventory.routes
      .map(({ route, method, status }) => ({ route, method, status }))
      .sort((a, b) =>
        `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`),
      ),
  });
  return {
    blocking:
      JSON.stringify(classifications(frozen)) !==
      JSON.stringify(classifications(current)),
    advisory: JSON.stringify(frozen) !== JSON.stringify(current),
  };
}
