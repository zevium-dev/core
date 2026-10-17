# Legal and support pages ship as work in progress

> Date: 2026-10-17 · Status: accepted (built, not committed) · Decided by: owner

## Decision

The Claude Connectors Directory listing needs public Privacy Policy, Terms of
Service and Support pages. Ship `/privacy`, `/terms` and `/support` now as
clearly marked work-in-progress pages. Do not write or invent legal text; each
page states the policy is being finalized and gives the one thing that is true
today: how to contact Zevium.

## Shape

- One shared `WipPage` component: public header, single `main#main-content`
  landmark, decorative one-shot SVG illustration, "In progress" badge, `h1`,
  one-line lede, page-specific contact, site footer.
- Illustrations are on-brand restraint, not ambient motion: they play once on
  arrival using motion tokens only and render the finished drawing under
  reduced motion.
- Support contact is a single constant, `SUPPORT_EMAIL` in
  `apps/web/src/lib/contact.ts`. `support@zevium.dev` is a **placeholder
  pending owner confirmation**: no support inbox existed in repo config or notes,
  and the mailbox may not exist yet.
- Footer links to all three pages from landing, docs and the pages themselves
  (shared `SiteFooter`).

## Follow-ups (owner)

- Confirm or replace `SUPPORT_EMAIL`, and make sure the inbox receives mail
  before the directory submission.
- Replace each placeholder with real, reviewed policy text before launch.
