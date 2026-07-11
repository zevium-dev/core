E2E SIGN-IN FIX LANE. Project: /home/tnfssc/Code/zevium. Edit ONLY files under e2e/. Dev server already running on http://localhost:3000 — do NOT restart it. `agent-browser` CLI installed globally.

Suite failed in e2e/lib.sh sign_in(). Root causes found by orchestrator (proven manually in fresh session — DO NOT rediscover, apply exactly):

1. `ab find role button click --name "Continue"` fuzzy-matches the "Continue with Google" social button (first in DOM) → navigates to Google OAuth. Never use name-based find for Clerk submit buttons.
2. CSS `ab click 'form button[type="submit"]'` on Clerk's form is INERT (click reports Done, form never submits). Working submit = focus the input then press Enter.
3. Seed user password was reset by orchestrator to `zevium-test-password` — creds valid now.

Proven working recipe (fresh session, from /sign-in):
```
agent-browser fill 'input[name="identifier"]' "$E2E_EMAIL"   # combined first screen may also show password field — ignore it
agent-browser focus 'input[name="identifier"]'; agent-browser press Enter
# → lands on /sign-in/factor-one ("Enter your password")
agent-browser fill 'input[name="password"]' "$E2E_PASSWORD"
agent-browser focus 'input[name="password"]'; agent-browser press Enter
# → lands on /sign-in/client-trust ("Check your email", textbox "Enter verification code")
agent-browser fill 'input' '424242'   # OTP auto-submits after fill, no button click needed
# → signed in, redirected to /
```
Keep the existing polling loop structure (states can arrive in different order / factor-one may be skipped on trusted client): each iteration inspect URL + page text, act per state (identifier form → fill+Enter; password visible → fill+Enter; verification code → fill OTP; url has /app or Clerk user exists → success). `agent-browser eval "window.Clerk?.user?.id ?? ''"` is a reliable signed-in check. After success land on /app and assert shell renders.

TASK:
1. Rewrite sign_in() in e2e/lib.sh per above. Keep is_signed_in short-circuit.
2. Run `bash e2e/run-all.sh`. Iterate until 01-auth passes fully. 02-publisher / 03-consumer: iterate on SCRIPT bugs (selectors, timing) until they pass or fail ONLY on genuinely missing app functionality — do NOT edit app code (apps/, convex/ are read-only for you).
3. Artifacts in e2e/artifacts/ on failure already handled — keep it.

End with `DONE: <pass/fail per script; for fails: exact step + why + whether app gap or script gap>` or `BLOCKED: <reason>`.
