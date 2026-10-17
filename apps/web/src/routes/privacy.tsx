import { createFileRoute } from "@tanstack/react-router";

import { WipPage } from "#/components/wip-page";
import { SUPPORT_EMAIL } from "#/lib/contact";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy · Zevium" },
      {
        name: "description",
        content:
          "Zevium's privacy policy is being finalized. Contact support with questions.",
      },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <WipPage
      title="Privacy Policy"
      lede="We're finalizing this policy. The full text will be published on this page."
      illustration="privacy"
    >
      <p className="text-sm text-muted-foreground">
        Questions about your data in the meantime? Email{" "}
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
