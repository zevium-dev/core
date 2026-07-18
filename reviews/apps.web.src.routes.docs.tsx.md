# Tiger Review — Docs site (`apps/web/src/routes/docs/*` + `components/docs-*.tsx`)

Scope: `apps/web/src/routes/docs/index.tsx`,
`apps/web/src/routes/docs/consuming.tsx`,
`apps/web/src/routes/docs/publishing.tsx`,
`apps/web/src/routes/docs/agents.tsx`,
`apps/web/src/components/docs-layout.tsx`,
`apps/web/src/components/docs-code-block.tsx`.

Supporting context read: `apps/web/src/lib/landing.ts`,
`apps/web/src/lib/motion.ts`, `apps/web/src/lib/vt.ts`,
`apps/web/src/styles.css`, `apps/web/src/components/public-header.tsx`,
`apps/web/src/routes/__root.tsx`, `apps/web/src/router.tsx` (VT callback),
and every other `<pre>` / `clipboard.writeText` site in the app for
proportionate-rigor calibration.

## Verdict

**Correct.** No blockers, no security issues, no correctness regressions.
The docs site faithfully follows every codebase convention: semantic color
tokens only (no raw Tailwind colors), motion via `var(--dur-*)` / `var(--ease)`
CSS vars (no hardcoded durations/easings), `content-enter` entrance animation
on the article, root `defaultViewTransition` cross-fade on docs→docs nav
(sibling nav, not list→detail, so no morph is required by the DESIGN.md
list→detail rule), no `isPending` misuse (no mutations/queries on these
routes), no missing skeletons (routes are pure static JSX with no `loader`),
no markdown rendering (all content is literal JSX → React escapes everything,
so no XSS surface), and every `<Link to>` target resolves to a registered route.

One minor (P3) behavioral nit on the copy button — non-blocking, "suboptimal
but correct." Reported below for completeness.

## File Stats

| File | Lines | Findings |
|---|---|---|
| `apps/web/src/routes/docs/index.tsx` | 121 | 0 |
| `apps/web/src/routes/docs/consuming.tsx` | 147 | 0 |
| `apps/web/src/routes/docs/publishing.tsx` | 177 | 0 |
| `apps/web/src/routes/docs/agents.tsx` | 101 | 0 |
| `apps/web/src/components/docs-layout.tsx` | 124 | 0 |
| `apps/web/src/components/docs-code-block.tsx` | 64 | 1 |

## Findings

### [SEV: P3] Copy-button "Copied" state flickers off on rapid re-clicks; timer leaks on unmount

**Location:** `apps/web/src/components/docs-code-block.tsx:23-31`

```tsx
async function onCopy() {
  try {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Copied");
    window.setTimeout(() => setCopied(false), 1500);
  } catch {
    toast.error("Could not copy — select and copy manually");
  }
}
```

**Problem.** The reset timer is not tracked in a ref, so a second copy click
within the 1500ms window schedules a *second* `setTimeout` while the first is
still pending. The first timer then fires `setCopied(false)` at its original
deadline, clearing the "Copied" indicator prematurely even though the most
recent copy is still within its own 1500ms window. Concretely: click at t=0
(T1 @ 1500ms), click again at t=500 (T2 @ 2000ms) → at t=1500 the button
flips from "Copied" back to "Copy" for ~500ms until T2's no-op `setCopied(false)`
runs. The timer is also never cleared on unmount, so navigating away mid-window
leaves a pending timer that calls `setState` on a gone component (no React 18
warning, but a real timer leak).

**Impact.** Cosmetic only — the copy itself always succeeds; only the
"Copied" affordance label/icon flickers on rapid double-clicks. No data,
security, or functional consequence.

**Note on proportionate rigor.** The identical untracked-`setTimeout` pattern
is used by four other copy buttons in the app (`routes/index.tsx:485`
`McpConfigBlock`, `app/settings/keys.tsx:189`, `project-settings-panel.tsx:452`,
`catalogue/$orgSlug.$projectSlug.tsx:622`). Flagged here only because the file
is in this patch's scope; the fix is trivial and standard (`useRef` +
`clearTimeout` before scheduling + `useEffect` cleanup) and could be applied
app-wide in one sweep if desired.

**Fix.**

```tsx
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

type DocsCodeBlockProps = {
  code: string;
  /** Display-only language label (no syntax highlighting — keeps bundle lean). */
  lang?: string;
  className?: string;
};

export function DocsCodeBlock({ code, lang, className }: DocsCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    };
  }, []);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copied");
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  }
```

---

## Checklist (what was verified clean)

- **XSS via rendered markdown/code:** No markdown renderer anywhere in the
  docs site — all page content is literal JSX (`<h2>`, `<p>`, `<ul>`,
  `<DocsCodeBlock>`). `DocsCodeBlock` renders `code` as a JSX text child
  (`<code>{code}</code>`) which React HTML-escapes; `lang`, `title`, and
  `description` are plain strings in `<span>`/`<h1>`/`<p>`. The only
  non-literal input to a code block is `GATEWAY`/`MCP_URL` derived from
  `import.meta.env.VITE_GATEWAY_URL` (build-time, trusted) — and it too flows
  through the escaped `{code}` child. No `dangerouslySetInnerHTML`, no
  `eval`, no `href` interpolation. No XSS surface.
- **Missing view-transition on nav:** `router.tsx:64` sets
  `defaultViewTransition` with a `types` callback, so every docs→docs
  navigation runs the root `::view-transition-old(root)`/`-new(root)`
  cross-fade (`styles.css:180-184`) and the article's `content-enter`
  entrance animation (`styles.css:164-174`). Docs nav is sibling-to-sibling
  (Getting started ↔ Publishing ↔ Consuming ↔ Agents), **not** list→detail,
  so the DESIGN.md "list→detail nav ships view-transition morph or written
  reason" rule does not apply. No morph missing.
- **isPending misuse:** No `useMutation`/`useQuery`/route `loader` on any
  docs page — all content is static JSX computed at module load. Nothing to
  pend.
- **Raw Tailwind colors:** Every class in `docs-layout.tsx` (PROSE_CLASS,
  sidebar, nav list) and `docs-code-block.tsx` uses semantic tokens
  (`text-foreground`, `text-muted-foreground`, `bg-muted/40`,
  `bg-accent`, `text-accent-foreground`, `border-border`, `text-primary`,
  etc.) or structural utilities (`rounded-lg`, `overflow-x-auto`,
  `size-3.5`). `text-[11px]` is an arbitrary *size*, not a color. No
  `red-500`/`blue-600`/etc. anywhere.
- **Hardcoded motion values:** The nav `Link` transition uses
  `duration-[var(--dur-instant)] ease-[var(--ease)]` (CSS vars from
  `styles.css:102-107`). `content-enter` animates with
  `var(--dur-page) var(--ease)`. No inline `duration-150`/`ease-out`/
  numeric ms literals.
- **Missing skeletons:** Docs routes declare no `loader` and no async data
  (`GATEWAY`/`MCP_URL` are synchronous module-scope constants). No
  `pendingComponent` is warranted — the page renders fully on first paint.
- **Dead code:** `DocsCodeBlock.className` is destructured and merged into the
  outer `div` via `cn(...)` — it is a functional, wired-up extensibility
  surface (standard shadcn convention) that no current caller passes. Not
  dead (it executes when present); not flagged. All other imports are used:
  `Link` (index/consuming/publishing), `useRouterState`/`Menu`/`Sheet*`
  (layout), `Check`/`Copy`/`toast` (code-block), `resolveGatewayOrigin`/
  `mcpEndpointUrl`/`discoveryEndpointUrl`/`buildMcpConfigSnippet` (agents).
- **Copy-to-clipboard without clear:** `DocsCodeBlock.onCopy` sets
  `copied=true` then schedules `setCopied(false)` at 1500ms — a clear
  **does** exist. The only defect is that the timer is untracked (see P3
  above).
- **Broken anchors:** Every `<Link to>` resolves to a registered route:
  `/app` (`routes/app/index.tsx`), `/app/settings/keys`
  (`routes/app/settings/keys.tsx`), `/app/projects`
  (`routes/app/projects/index.tsx`), `/catalogue` (`routes/catalogue.tsx`),
  `/docs` + `/docs/consuming` + `/docs/publishing` + `/docs/agents`
  (the four files in scope). `DOCS_SECTIONS` `to` values are a `as const`
  literal union typechecked against the route tree. No in-page `#` anchor
  links exist (headings have no `id`/`<a href="#">`), so no broken in-page
  anchors either.

## Summary

- **Counts:** P0: 0 · P1: 0 · P2: 0 · P3: 1 · Total: 1
- **Top issue:** Copy button's untracked `setTimeout` lets a prior timer
  clear the "Copied" state early on rapid re-clicks, and leaks the timer on
  unmount. Cosmetic only; copy always succeeds.

The docs site is clean and conventionally correct. The single finding is a
minor, non-blocking UX nit shared with four sibling components elsewhere in
the app.
