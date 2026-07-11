# Backlog

## Done (2026-07-11 session)

1. ~~Landing page v2~~ — shipped wave 6
2. ~~/app nav sluggish~~ — fixed (server-fn round-trips eliminated)
3. ~~Spec editor overhaul~~ — direction C, cuts 1+2 shipped
4. ~~Placeholder audit~~ — full FLOW parity, waves 7-9
5. ~~Browser try-it dead (no gateway CORS)~~ — fixed during product review
6. ~~Cross-org metering broken (only own-org calls; publisher wallet charged)~~ — fixed
7. ~~Mock required API key~~ — keyless now

## Open — product review findings (2026-07-12, ranked)

1. **New-user org gap.** Docs/quickstart promise "personal org created automatically" but
   Clerk `automatic_organization_creation` is DISABLED (verified via environment payload).
   Fresh users land org-less into empty states. Either enable Clerk auto-org-creation
   (dashboard) or build a forced create-org onboarding step after sign-up. Highest-impact
   funnel hole; couldn't test past sign-up CAPTCHA with automation.
2. **Catalogue looks like a junk drawer.** Six identical test projects, all "No description
   yet." Needs: (a) seed 3-4 polished demo APIs (weather / FX / embeddings, real upstreams),
   (b) publish-quality nudge — suggest/require description + tags before make-public,
   (c) cleanup of e2e-generated projects (delete via admin or `projects.remove`).
3. **Landing "APIs listed" stat mismatch** — hero says one number, catalogue shows another
   (teaser cap vs total). Count from a real total.
4. **"1 credits" grammar** on catalogue detail header (`· 1 credits`). Pluralize.
5. **Try-it key affordance** — API key field is a bare input; add "Get a key →" link
   (signed-out → sign-up, signed-in → /app/settings/keys). Key not prefillable (secret
   shown once — correct), but the path to one should be one click.
6. **In-app Docs access** — Docs link exists only in public header; app sidebar/header has
   none. Publishers deep in /app can't reach docs.
7. **Notification click-through** — bell items are dead text; version_deprecated should
   link to the project, low_balance to billing, webhook_failed to project settings.
8. **e2e gap that hid the CORS bug** — suite calls the gateway via curl only. Add one
   browser-fetch paid call + one anonymous mock call to 03-consumer so CORS-class
   regressions fail the suite.
9. Payout notifications need `notifications.kind` union extension (deferred from wave 9).

## Deferred (wave 10, user decisions)

- Production deploy (user: not yet)
- Generated SDKs (P2), reviews/ratings (P2), full crypto x402 settlement
