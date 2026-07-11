import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return <Outlet />;
}
