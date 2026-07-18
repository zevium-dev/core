# Tiger Review — `apps/web/src/components/project-settings-panel.tsx`

## Verdict

Do not merge. A realtime-driven `useEffect` silently destroys in-flight user
edits to Name/Description/Tags on every concurrent project-doc update —
including updates this component itself triggers via the Visibility dialog.
That is a user-facing data-loss race, full stop. Layered on top: a webhook
signing secret that never re-hides once revealed, false "empty" rendering
during query load (no skeletons, violating the project loading-state rule),
and a handful of DRY / stock-component regressions. No P0 security issue —
org-scoping is enforced server-side via `requireProjectMember` on every
touched mutation/query, errors are funneled through `humanError`, and color
usage is semantic-token only. But the P1 alone blocks.

## File Stats

- Path: `apps/web/src/components/project-settings-panel.tsx`
- Lines: 640
- Imports: Convex (`api.projects`, `api.webhooks`), TanStack Query/Router,
  shadcn/ui (Card, Dialog, Switch, Input, Label, Badge, Button), lucide, sonner.
- Components: `ProjectSettingsPanel`, `WebhooksCard` (private), `isValidWebhookUrl` (private).
- Findings: P0 = 0 · P1 = 1 · P2 = 3 · P3 = 4

## Findings

### [P1] Realtime `useEffect` overwrites unsaved Name/Description/Tags edits

**Location:** `ProjectSettingsPanel`, lines ~60-65:

```tsx
useEffect(() => {
  setName(project.name);
  setDescription(project.description ?? "");
  setTagsText(project.tags.join(", "));
}, [project.name, project.description, project.tags, project._id]);
```

**Problem:** `project.tags` is a **fresh array reference on every Convex doc
snapshot** — Convex returns new array instances per emit, so reference-equality
in the deps array fails on *every* realtime update of the project doc, even
when `name`/`description`/`tags` values are byte-identical. The effect then
unconditionally calls `setName`/`setDescription`/`setTagsText`, blowing away
whatever the user is currently typing. The comment ("Keep local form in sync
when realtime project doc changes (e.g. header visibility)") admits the
trigger — and the Visibility dialog in this same component is itself a
trigger: `setVisibility.onSuccess` calls `invalidateProjectQueries()`, the
refetch returns a new `project` prop with a new `tags` array, the effect
fires, and any keystroke the user made in Name/Description/Tags while the
visibility mutation was in flight is lost.

**Impact:** Silent data loss. Reproducible: (a) open the panel, type a new
description, click "Make Public" → description field snaps back. (b) Two org
members editing concurrently clobber each other's unsaved drafts. (c) Any
unrelated realtime mutation landing on the project doc wipes the form.

**Fix:** Gate the sync on a "dirty" flag (set true on any field `onChange`,
cleared on successful save) and skip the effect while dirty; or compare
values, not references:

```tsx
const tagsKey = project.tags.join("\0");
useEffect(() => {
  setName(project.name);
  setDescription(project.description ?? "");
  setTagsText(project.tags.join(", "));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [project.name, project.description, tagsKey, project._id]);
```

Better: only resync on `project._id` change (panel remount per project) and
trust optimistic updates for the rest. The current "keep in sync" rationale is
already covered by `saveDetails`'s optimistic `setQueryData` + invalidation.

---

### [P2] Webhook signing secret never auto-hides after reveal

**Location:** `WebhooksCard`, `revealSecret` state, lines ~410 / 478-490:

```tsx
const [revealSecret, setRevealSecret] = useState(false);
...
<Input readOnly value={revealSecret ? endpoint.secret : maskSecret(endpoint.secret)} ... />
<Button ... onClick={() => setRevealSecret((v) => !v)} ...>
```

**Problem:** `revealSecret` flips to `true` and stays true for the lifetime
of the component mount. The plaintext secret sits in the DOM (and the
accessibility tree) with no timeout, no blur handler, no reset on endpoint
doc update. The only way to re-mask is the user clicking the eye again.

**Impact:** Unbounded shoulder-surfing / DOM-inspection window for a
credential that signs inbound webhooks. Project rule: secrets should be
momentarily revealed, not parked in plaintext.

**Fix:** Auto-hide after a short timeout (e.g. 30s) and/or on blur:

```tsx
useEffect(() => {
  if (!revealSecret) return;
  const t = setTimeout(() => setRevealSecret(false), 30_000);
  return () => clearTimeout(t);
}, [revealSecret, endpoint?._id]);
```

Also reset `revealSecret` to `false` whenever `endpoint?._id` changes (new
endpoint → new secret → don't carry over "revealed" state).

---

### [P2] Loading states render false empty content instead of skeletons

**Location:** `WebhooksCard`, lines ~398-402:

```tsx
const endpoint = endpointQuery.data ?? null;
const deliveries = deliveriesQuery.data?.page ?? [];
```

**Problem:** Neither `endpointQuery` nor `deliveriesQuery` is gated on a
loading flag. During the initial fetch `data` is `undefined`, so `endpoint`
collapses to `null` and `deliveries` to `[]`. The card then renders the
"Save an endpoint to generate a signing secret" empty-state, the
"Create an endpoint to start receiving deliveries" empty-state, and the
"No deliveries yet" empty-state — all **false** empties, flashed before the
query resolves. This directly violates the project loading-state rule
("loading = layout-stable skeletons, `isPending` (never `isLoading`)");
here neither `isPending` nor `isLoading` is consulted at all.

**Impact:** Misleading UI flash on every mount; users may believe no endpoint
exists and click "Create endpoint" against an endpoint that does exist,
racing the in-flight `getEndpoint` and overwriting the real secret/url.

**Fix:** Branch on the pending state and render skeletons:

```tsx
const endpointPending = endpointQuery.isPending;
const deliveriesPending = deliveriesQuery.isPending;
...
{endpointPending ? <Skeleton className="h-9 w-full" /> : endpoint?.secret ? (...) : (<p>...empty...</p>)}
...
{deliveriesPending ? (
  <ul className="space-y-1.5">{Array.from({length: 3}).map((_,i) => <Skeleton key={i} className="h-12 w-full" />)}</ul>
) : deliveries.length === 0 ? (...) : (...)}
```

---

### [P2] `active` defaults to `true` — can silently flip an inactive endpoint on save

**Location:** `WebhooksCard`, lines ~409 / 416-419:

```tsx
const [active, setActive] = useState(true);
...
useEffect(() => {
  if (endpoint !== null) {
    setUrl(endpoint.url);
    setActive(endpoint.active);
  }
}, [endpoint?._id, endpoint?.url, endpoint?.active]);
```

Combined with the `dirty` guard:

```tsx
const dirty = endpoint === null ? trimmedUrl.length > 0 : trimmedUrl !== endpoint.url || active !== endpoint.active;
```

**Problem:** While `getEndpoint` is still pending, `endpoint === null` and
`active === true`. The Save button enables as soon as the user types a URL
(`dirty = trimmedUrl.length > 0`). If the user pastes a URL and hits Save
before the query resolves, `saveEndpoint({ url, active: true })` is sent for
an endpoint that may actually be `active: false`. Server-side
`upsertEndpoint` uses `args.active ?? existing.active`, but the client always
passes a concrete boolean, so the existing value is overwritten — an
inactive endpoint is silently re-activated.

**Impact:** A user editing the URL of a deliberately-disabled endpoint (e.g.
an endpoint paused during an incident) can re-arm it without intending to,
simply by being faster than the network round-trip. Webhook deliveries
resume against an endpoint the operator believed was off.

**Fix:** Track a "loaded" sentinel and disable Save until the endpoint query
has resolved (or explicitly closed empty):

```tsx
const endpointLoaded = !endpointQuery.isPending && !endpointQuery.isError;
...
disabled={saving || !urlValid || !dirty || !endpointLoaded}
```

Or initialize `active` from a `useState(() => endpoint?.active ?? true)` only
after first load and render the Switch disabled until loaded.

---

### [P3] Raw `<textarea>` instead of stock shadcn `Textarea`

**Location:** `ProjectSettingsPanel`, description field, lines ~213-224:

```tsx
<textarea
  id="settings-description"
  value={description}
  ...
  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
/>
```

**Problem:** Hand-rolled textarea with manually-inlined shadcn Textarea
classes. Project UI rule: "stock shadcn unmodified." This duplicates the
canonical `Textarea` component's class string; future shadcn updates to
`Textarea` won't propagate here, and the inline string is a copy-paste
maintenance trap.

**Impact:** Style drift; ~8 lines of class noise; violation of the
stock-component rule.

**Fix:** `import { Textarea } from "#/components/ui/textarea"` and replace
the raw `<textarea>` with `<Textarea id="settings-description" ... />`.

---

### [P3] `isValidWebhookUrl` duplicates `convex/webhooks.ts`

**Location:** lines ~627-638:

```tsx
/** Mirrors convex/webhooks.ts validateWebhookUrl (https or http://localhost). */
function isValidWebhookUrl(url: string): boolean { ... }
```

**Problem:** Exact copy of `validateWebhookUrl` from `convex/webhooks.ts`,
admitted by the comment. Two implementations can drift: when the server
rule changes (e.g. allowing `http://127.0.0.1`, or a port range for dev),
the client will either reject valid URLs or accept invalid ones, producing
inconsistent UX where the client says "valid" but the server rejects (or
vice versa). The client-side gate is also redundant — `upsertEndpoint`
re-validates server-side and the error surfaces via `humanError`.

**Impact:** DRY violation; future drift risk; redundant validation that can
disagree with the source of truth.

**Fix:** Export `validateWebhookUrl` from a shared package (the repo already
has `shared/validate`) and import in both `convex/webhooks.ts` and this
component; or drop the client check, rely on server validation, and surface
the server's error message in the URL field's helper text.

---

### [P3] `deleteProject.onSuccess` never clears `deleteConfirm`

**Location:** lines ~109-119:

```tsx
onSuccess: async () => {
  toast.success("Project deleted");
  setDeleteOpen(false);
  await queryClient.invalidateQueries({ ... });
  void navigate({ to: "/app/projects" });
},
```

Combined with the dialog's `onOpenChange`:

```tsx
onOpenChange={(open) => {
  if (deletePending) return;        // early-returns during mutation
  setDeleteOpen(open);
  if (!open) setDeleteConfirm("");
}}
```

**Problem:** The success path calls `setDeleteOpen(false)` directly, bypassing
`onOpenChange` (which is the only place `setDeleteConfirm("")` is invoked).
So `deleteConfirm` retains the stale slug string after deletion. The
`onOpenChange` early-return on `deletePending` also means the clear-branch is
unreachable during the mutation window. If the component is reused without
unmounting (e.g. if this panel is ever rendered inside a list-detail shell
that recycles the route component), the confirm input is pre-primed with the
old slug and a second delete attempt could be one-click.

**Impact:** Stale state; double-delete race in any non-remounting host.
Today likely single-use (navigate-away unmounts), but the inconsistency is a
latent footgun.

**Fix:** Clear both in `onSuccess`:

```tsx
setDeleteOpen(false);
setDeleteConfirm("");
```

---

### [P3] `canDelete` slug comparison is case-sensitive; sequential invalidation

**Location:** line ~122 and `invalidateProjectQueries` ~67-77:

```tsx
const canDelete = deleteConfirm.trim() === project.slug;
```

**Problem 1:** `project.slug` is server-normalized to lowercase; the confirm
input is trimmed but not lowercased. A user typing `My-Project` (matching
the displayed project name casing) is told they haven't matched. The
placeholder does show the lowercase slug, which mitigates, but the
comparison should normalize both sides: `deleteConfirm.trim().toLowerCase()
=== project.slug`.

**Problem 2:** `invalidateProjectQueries` awaits two invalidations
sequentially:

```tsx
await queryClient.invalidateQueries({ queryKey: convexQuery(api.projects.get, {...}).queryKey });
await queryClient.invalidateQueries({ queryKey: convexQuery(api.projects.list, {...}).queryKey });
```

These are independent and can be `Promise.all`'d for parallel refetch.

**Impact:** Minor UX friction (false negative on confirm match) + minor
perf (serial refetch).

**Fix:**

```tsx
const canDelete = deleteConfirm.trim().toLowerCase() === project.slug;
...
await Promise.all([
  queryClient.invalidateQueries({ queryKey: convexQuery(api.projects.get, {...}).queryKey }),
  queryClient.invalidateQueries({ queryKey: convexQuery(api.projects.list, {...}).queryKey }),
]);
```

---

## Summary

**Counts:** P0 = 0 · P1 = 1 · P2 = 3 · P3 = 4 · **Total = 8**

**Top 3:**

1. **[P1] Realtime `useEffect` wipes unsaved Name/Description/Tags** on every
   concurrent project-doc update — including ones this component triggers via
   the Visibility dialog. Silent data loss; blocks merge.
2. **[P2] Webhook signing secret never auto-hides** once revealed; plaintext
   lingers in the DOM/accessibility tree indefinitely. Add a timeout + reset
   on endpoint change.
3. **[P2] Loading states render false empty content** (no skeletons, no
   `isPending` branching) — violates the project loading-state rule and can
   race the user into "Create endpoint" against an existing endpoint.

**Cross-cutting notes (no findings, verified clean):**
- Org-scoping is enforced server-side: every touched Convex entry point
  (`projects.update`, `projects.remove`, `webhooks.upsertEndpoint`,
  `webhooks.getEndpoint`, `webhooks.listDeliveries`) calls
  `requireProjectMember(ctx, projectId)` / `requireOrgMemberBySlug`. The
  client never passes `orgSlug` to mutations; it only flows into query-cache
  invalidation keys. ✓
- Errors are funneled through `humanError(err, "…")` — no raw internal
  exception text leaks to toasts. ✓
- Color usage is semantic-token only (`text-destructive`,
  `border-destructive/40`, `text-muted-foreground`, `text-success-foreground`,
  `border-warning/40`, `bg-warning/10`, `text-foreground`, `border-border`).
  No raw Tailwind colors. ✓
- No Motion components / hardcoded motion — the only transition is a CSS
  `transition-[color,box-shadow]` on the raw textarea (gone once P3 #1 is
  fixed by adopting stock `Textarea`). ✓
- Mutation invocation convention respected: `.mutate()` in handlers
  (`saveDetails`, `setVisibility`, `saveEndpoint`, `deleteProject`), no
  `.mutateAsync()`. `isPending` used for all pending flags (never
  `isLoading`). ✓
- `prefers-reduced-motion`: n/a (no Motion). ✓
- Optimistic update + rollback present on `saveDetails`; `setVisibility` and
  `saveEndpoint` omit optimistic updates (acceptable, not required).
