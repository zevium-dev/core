import { createFileRoute } from "@tanstack/react-router";

import { WipPage } from "#/components/wip-page";
import { SUPPORT_EMAIL } from "#/lib/contact";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service · Zevium" },
      {
        name: "description",
        content:
          "Zevium's terms of service are being finalized. Contact support with questions.",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <WipPage
      title="Terms of Service"
      lede="We're finalizing these terms. The full text will be published on this page."
      illustration="terms"
    >
      <p className="text-sm text-muted-foreground">
        Questions about using Zevium in the meantime? Email{" "}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="link-draw font-medium text-foreground"
        >
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </WipPage>
  );
}
