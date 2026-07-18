E2E SCRIPTS LANE. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, FLOW.md (§8 golden paths), .project/PLAN.md. Edit ONLY: e2e/ directory (new) + root package.json scripts. The `agent-browser` CLI is installed globally (run `agent-browser --help`; core docs: `agent-browser skills get core`).

GOAL: reusable browser E2E scripts in-repo.

1. e2e/lib.sh — helpers: wait_for_url (curl poll), snapshot helpers, assert helpers (fail with message + screenshot to e2e/artifacts/), sign_in() using seed creds test+clerk_test@zevium.dev / zevium-test-password with OTP 424242 fallback step (detect OTP screen via snapshot text, type 424242). Session persists across agent-browser calls — sign_in should short-circuit if already signed in (open /app, check URL not redirected).
2. e2e/01-auth.sh — anonymous / → 200 with hero text; /app redirects to sign-in; sign_in(); /app/projects loads signed-in (no 'Something went wrong').
3. e2e/02-publisher.sh — golden path: sign_in → /app/projects → create project (name "E2E Weather <timestamp>", unique slug) → spec editor → paste minimal OpenAPI JSON (servers[0].url=https://httpbin.org, paths./get.get.x-zevium-cost=1) via textarea/editor fill → save draft → assert no issues → publish 0.0.1 → assert success toast/badge → make public → assert catalogue /catalogue shows the project.
4. e2e/03-consumer.sh — /catalogue (anonymous) lists published project; open detail page; pricing table shows credits; try-it panel renders (do NOT make a paid call unless GATEWAY_URL env set — if set: paste key from E2E_API_KEY env, fire /get call, assert 200 and x-zevium-cost header).
5. e2e/run-all.sh — run in order, exit nonzero on first failure, summary at end. Root package.json: "e2e": "bash e2e/run-all.sh".
6. Scripts must be idempotent-ish (unique project names per run), artifacts in e2e/artifacts/ (gitignore it). App expected on http://localhost:3000 (E2E_BASE_URL env override). RUN the suite yourself against the live dev server on :3000 and iterate until 01 passes fully and 02/03 pass or fail ONLY on genuinely missing app functionality — report which steps fail and why (screenshots referenced). Known WIP: /app/projects may error on SSR auth (fix in flight) — write scripts to final spec regardless.

End with `DONE: <pass/fail per script + failures explained>` or `BLOCKED:`.
