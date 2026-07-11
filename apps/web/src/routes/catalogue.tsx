import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/catalogue")({
  component: CatalogueLayout,
});

function CatalogueLayout() {
  return <Outlet />;
}
