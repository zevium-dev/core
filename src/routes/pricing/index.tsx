import { createFileRoute } from "@tanstack/react-router";

import PricingTable from "~/components/autumn/pricing-table";

export const Route = createFileRoute("/pricing/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <PricingTable />;
}
