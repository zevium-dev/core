import { createFileRoute, Link } from "@tanstack/react-router";

import { WipPage } from "#/components/wip-page";
import { Button } from "#/components/ui/button";
import { SUPPORT_EMAIL } from "#/lib/contact";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Support · Zevium" },
      {
        name: "description",
        content: `Get help with Zevium: email ${SUPPORT_EMAIL} or read the docs.`,
      },
    ],
  }),
  component: SupportPage,
});

function SupportPage() {
  return (
    <WipPage
      title="Support"
      lede="We're building a full help center. Until then, email reaches the team directly."
      illustration="support"
    >
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild>
          <a href={`mailto:${SUPPORT_EMAIL}`}>Email {SUPPORT_EMAIL}</a>
        </Button>
        <Button asChild variant="outline">
          <Link to="/docs">Read the docs</Link>
        </Button>
      </div>
    </WipPage>
  );
}
