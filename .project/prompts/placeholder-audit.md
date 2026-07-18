Read-only task — do NOT modify any files.

Project: /home/tnfssc/Code/zevium — apps/web is TanStack Start app, convex/ is backend, apps/gateway CF worker.

TASK: exhaustive audit of incomplete/placeholder surfaces in the product. User reports /app settings page is a placeholder. Find EVERYTHING unfinished:

1. grep apps/web/src (and convex/) for: TODO, FIXME, placeholder, "coming soon", "Coming soon", stub, WIP, not implemented, lorem
2. Read every route file under apps/web/src/routes/ and judge: is this screen real (wired to Convex data, functional actions) or shell/placeholder (static text, dead buttons, fake data)?
3. Compare against FLOW.md at /home/tnfssc/Code/zevium/FLOW.md — list every screen FLOW.md specifies that is missing or stubbed.
4. Note dead buttons / links to nowhere / forms that don't submit.

Output contract — end with:
PLACEHOLDERS: <list: route path — file:line — what's missing — what data/decision it needs>
MISSING VS FLOW.md: <list>
End with DONE.
