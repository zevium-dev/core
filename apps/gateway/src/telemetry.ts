export type DependencyComponent =
  "catalogue_source" | "public_spec_source" | "internal_spec_source";

/** Explicit allowlist: no raw errors, tenant ids, key ids, or request ids. */
export function logDependencyFailure(
  component: DependencyComponent,
  status?: number,
): void {
  console.error(
    JSON.stringify({
      schema: 1,
      type: "zevium.dependency_failure",
      component,
      ...(status === undefined
        ? {}
        : { statusClass: `${Math.floor(status / 100)}xx` }),
    }),
  );
}
