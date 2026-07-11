E2E FINISH LANE (02-publisher, 03-consumer). Project: /home/tnfssc/Code/zevium. Edit ONLY files under e2e/. apps/, convex/ are READ-ONLY (read for selectors/flows). Dev server running on http://localhost:3000 — do NOT restart. `agent-browser` CLI installed globally.

STATE: 01-auth.sh PASSES. 02 fails at "create project": form fill works but the submit click was silently inert.

ROOT CAUSE (proven by orchestrator — apply, don't rediscover): agent-browser `click`/`find ... click` does NOT scroll the target into view; clicking an element below the fold silently no-ops (reports ✓ Done). Fix pattern, proven working:

```sh
agent-browser eval "document.querySelector('button[type=submit]')?.scrollIntoView({block:'center'}); 'ok'"
agent-browser find role button click --name "Create project"
# → navigates to /app/projects/<slug>, toast "Project created"
```

TASK:
1. Add helper to e2e/lib.sh: `click_button <accessible-name> [css-fallback]` — scrollIntoView (via eval, match by text or css) then `ab find role button click --name`, fallback `ab click <css>`. Use `{block:'center'}`.
2. Replace ALL button clicks in 02-publisher.sh / 03-consumer.sh with the helper (form submits may alternatively use `agent-browser eval "document.querySelector('form')?.requestSubmit()"` — also proven working).
3. Run `bash e2e/02-publisher.sh` then `bash e2e/03-consumer.sh`, iterate on SCRIPT bugs (selectors, timing, scroll) until both pass or fail ONLY on genuinely missing app functionality. Read apps/web/src/routes for actual selectors/flows (spec editor, publish button, make-public toggle) instead of guessing.
4. Sign-in already works (lib.sh recipe: fill + focus + press Enter; OTP 424242 auto-submits). Don't touch sign_in().
5. Known junk data: projects `manual-repro-1628`, `scroll-test-1`, and possibly earlier `e2e-weather-*` exist in the test org — fine, ignore; use fresh timestamped slugs.
6. GATEWAY_URL/E2E_API_KEY are unset — 03's paid-call step must stay skipped (per script spec).

End with `DONE: <02 pass/fail, 03 pass/fail; for fails: exact step + app gap vs script gap>` or `BLOCKED: <reason>`.
