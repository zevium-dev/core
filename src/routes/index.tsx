import { createFileRoute } from "@tanstack/react-router";

import { ScreenCenter } from "~/components/ui/screen-center";
export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <ScreenCenter>
      <div className="z-10 flex items-center justify-center px-4">
        <div className="text-foreground mx-auto text-3xl font-normal lg:text-5xl">
          <span>zevium.dev</span>
        </div>
      </div>
    </ScreenCenter>
  );
}
