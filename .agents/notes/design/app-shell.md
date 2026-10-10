# Cross-cutting UI

> Updated: 2026-10-10 (moved from former `FLOW.md` §7)
> Code: `apps/web/src/components/`, `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/app.tsx`, `apps/web/src/routes/-app-landmarks.test.tsx`
> Related: [design system](design-system.md), [webhooks-notifications](../features/webhooks-notifications.md)

UI behaviour shared by every screen. Visual and motion rules: [design-system.md](design-system.md).

- **Global shell**: collapsible sidebar, org switcher, breadcrumb header, theme toggle, user menu — motion per [design system](design-system.md) (nav pill slides, sidebar collapse animation)
- **App sidebar** (`/app`): org switcher, Dashboard, Catalogue, Projects, Settings, theme, user menu. Dashboard content: [wallet-billing](../features/wallet-billing.md) (balance card, usage) + first-visit onboarding checklist (get key → make first call → top up)
- **Landmarks (#397)**: `AppSidebar` wraps its contents in `<nav aria-label="App navigation">` inside the stock `Sidebar`, so the landmark follows content into the mobile sheet portal and desktop peer layout stays intact. `SidebarInset` remains the only app `<main>`; the focusable `#main-content` skip target sits inside it. Loading/error states preserve both. `RouteError` remains a `div` (PR #382).
- **Toasts**: human-readable messages only — never raw errors/internals
- **Confirm dialogs**: global, promise-based, queued
- **Notifications (email + in-app)**: verification, invitations, budget thresholds, deprecation/sunset notices, payout notices, listing-status changes — see [webhooks-notifications](../features/webhooks-notifications.md)
- **Empty states**: every list has one, with a CTA (per design system, revealed once)
- **Skeletons**: layout-stable, shaped like the real content
