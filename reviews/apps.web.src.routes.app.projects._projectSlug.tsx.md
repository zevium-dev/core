# Tiger Review — `apps/web/src/routes/app/projects/$projectSlug.tsx` + `apps/web/src/components/project-settings-panel.tsx`

## Verdict

**Incorrect** — ship-blocking correctness issue (unsaved-changes data loss under realtime sync) plus several UI-rule violations (missing skeleton on webhook load, raw `<textarea>` instead of stock `Textarea`, hardcoded motion timer, type-unsafe optimistic update). No P0 data-corruption, but the `useEffect`-overwrites-edits bug will bite the moment two members touch the same project, or even one member publishes a spec while another is typing.

## File Stats

| File | Lines | LoC reviewed |
|---|---|---|
| `apps/web/src/routes/app/projects/$projectSlug.tsx` | 655 | full |
| `apps/web/src/components/project-settings-panel.tsx` | 640 | full |
| Cross-ref: `apps/web/src/components/ui/textarea.tsx`, `apps/web/src/lib/motion.ts`, `apps/web/src/styles.css`, `apps/web/src/lib/project-helpers.ts`, `apps/web/src/lib/human-error.ts` | — | confirm only |

## Findings

### [SEV: P1] Realtime `useEffect` sync silently overwrites unsaved local edits

**Location** — `apps/web/src/components/project-settings-panel.tsx:42-48` (details form) and `:325-330` (webhook form)

```tsx
useEffect(() => {
  setName(project.name);
  setDescription(project.description ?? "");
  setTagsText(project.tags.join(", "));
}, [project.name, project.description, project.tags, project._id]);
```
```tsx
useEffect(() => {
  if (endpoint !== null) {
    setUrl(endpoint.url);
    setActive(endpoint.active);
  }
}, [endpoint?._id, endpoint?.url, endpoint?.active]);
```

**Problem.** Both effects unconditionally clobber local component state whenever the upstream Convex doc changes. The `projects.get` subscription is live for the entire panel lifetime, so any field mutation that touches `name` / `description` / `tags` (or `webhooks.getEndpoint`'s `url` / `active`) repopulates the form fields *while the user is typing*, discarding uncommitted edits with no warning, no diff, no dirty guard.

Concrete trigger paths that exist in this very codebase:
1. Multi-member org: Admin A types a new project name. Admin B (or another tab) saves a rename. Realtime push fires `project.name` change → Admin A's half-typed name is silently replaced.
2. Same user, two tabs: Tab 1 edits tags, Tab 2 toggles visibility. `setVisibility.onSuccess` invalidates `projects.get`; the refetch lands in Tab 1 and resets `tagsText` (only if `tags` also changed server-side — but any concurrent publish flow that re-normalizes tags will trip it).
3. Webhook URL: user pastes a new URL, hasn't hit Save. A push refreshes the endpoint doc (e.g. `active` flipped elsewhere) → `url` state is reset to the old endpoint URL.

The dependency arrays key on primitives, so unchanged fields don't re-fire — but the moment *any* tracked field moves, *all* three setters run, wiping fields that *were* being edited even if they weren't the ones that changed.

**Impact.** Silent loss of in-progress input. The user gets no toast, no dialog, no "discard changes?" prompt — the field just snaps back. Worst case: they don't notice and Save submits the stale value overwriting their own intent, or they lose minutes of typing.

**Fix.** Gate the sync on a "no local edits since last save" flag, or only seed initial state when transitioning from `undefined`/loading to a real doc:

```suggestion
const [seeded, setSeeded] = useState(false);
useEffect(() => {
  if (seeded) return;
  if (!project) return;
  setName(project.name);
  setDescription(project.description ?? "");
  setTagsText(project.tags.join(", "));
  setSeeded(true);
}, [project, seeded]);
```

Or track a `dirty` bit derived from `name !== project.name || description !== (project.description ?? "") || tagsText !== project.tags.join(", ")` and skip the setters while dirty. The WebhooksCard effect needs the same treatment keyed on a local `dirty` flag (which already exists at `:341` — reuse it).

### [SEV: P2] `WebhooksCard` flashes "Create endpoint" before real endpoint loads (missing skeleton)

**Location** — `apps/web/src/components/project-settings-panel.tsx:307-311`

```tsx
const endpointQuery = useQuery(
  convexQuery(api.webhooks.getEndpoint, { projectId: project._id }),
);
// ...
const endpoint = endpointQuery.data ?? null;
```

**Problem.** `useQuery` (not `useSuspenseQuery`) means `data` is `undefined` on first render. The component treats `endpoint === null` as "no endpoint exists" and renders the empty form with the **"Create endpoint"** button text (`endpoint === null ? "Create endpoint" : "Save changes"` at `:455`), plus the "Save an endpoint to generate a signing secret." placeholder (`:438`). When the query resolves and an endpoint *does* exist, the form populates, the button relabels to "Save changes", and the secret field appears — a visible layout shift and a momentary false state.

This directly violates the project UI rule: *"loading = layout-stable skeletons, isPending (never isLoading)"*. The whole settings tab is mounted synchronously (no `Suspense` boundary around it — see `$projectSlug.tsx:303-305`), so the WebhooksCard is the one place that can flash.

**Impact.** Users who already have a webhook endpoint see "Create endpoint" + an empty URL field for one frame on every visit. Confusing and looks broken. If they click "Create endpoint" before the load completes, the form's local `url` state is `""`, validation fails, and nothing happens — but the perceived state is wrong.

**Fix.** Either suspend with a skeleton, or branch on the query's pending state to render a `Skeleton` for the card body until the first response:

```suggestion
const endpointQuery = useQuery(
  convexQuery(api.webhooks.getEndpoint, { projectId: project._id }),
);
const endpoint = endpointQuery.data ?? null;
const endpointLoading = endpointQuery.isLoading;
```
Then render `<Skeleton className="h-64 rounded-xl" />` while `endpointLoading` before falling into the form. Cleaner: wrap `WebhooksCard` in its own `<Suspense fallback={<Skeleton className="h-64" />}>` and switch to `useSuspenseQuery`.

### [SEV: P2] Raw `<textarea>` reinvents stock `Textarea` component

**Location** — `apps/web/src/components/project-settings-panel.tsx:144-156`

```tsx
<textarea
  id="settings-description"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
  maxLength={2000}
  disabled={savePending}
  rows={4}
  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
/>
```

**Problem.** The repo ships `apps/web/src/components/ui/textarea.tsx` — the stock shadcn `Textarea`. The settings panel copy-pastes its `className` (verbatim down to `border-input`, `shadow-xs`, `focus-visible:ring-ring/50`) and then diverges (`min-h-24` + `text-sm` vs. the stock `min-h-16` + `text-base md:text-sm`). This duplicates styling that already lives in one place and will drift the next time `ui/textarea.tsx` is updated. Violates the project rule: *"stock shadcn unmodified"*.

**Impact.** Two sources of truth for textarea appearance. The hand-rolled version also drops `field-sizing-content`, `aria-invalid` handling, and `dark:bg-input/30` from the stock component — so dark-mode and invalid-state styling silently differ from every other textarea in the app.

**Fix.**

```suggestion
<Textarea
  id="settings-description"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
  maxLength={2000}
  disabled={savePending}
  rows={4}
  className="min-h-24 text-sm"
/>
```
Add `import { Textarea } from "#/components/ui/textarea";` to the import block.

### [SEV: P3] Optimistic update writes `undefined` into a `string | null` field

**Location** — `apps/web/src/components/project-settings-panel.tsx:100-106`

```tsx
queryClient.setQueryData<Doc<"projects">>(queryOpts.queryKey, {
  ...previous,
  name: patch.name,
  description: patch.description ?? undefined,
  tags: patch.tags,
});
```

**Problem.** `Doc<"projects">["description"]` is `string | null`. The `?? undefined` collapses `null` to `undefined`, which is neither `string` nor `null`. Object spread with `description: undefined` does *not* delete the key — it sets it to `undefined` on the cached object. Downstream consumers that do `project.description === null` (vs. truthy checks) will misbehave against the optimistic cache between mutation success and the invalidate refetch.

**Impact.** Narrow window, but the cache shape lies about the type contract. Any code path that distinguishes "no description" (`null`) from "key absent" will get the wrong answer.

**Fix.** Pass `null` through directly:

```suggestion
queryClient.setQueryData<Doc<"projects">>(queryOpts.queryKey, {
  ...previous,
  name: patch.name,
  description: patch.description,
  tags: patch.tags,
});
```

### [SEV: P3] `formatMs(0)` produces `"0.0ms"` — inconsistent with all other whole numbers

**Location** — `apps/web/src/routes/app/projects/$projectSlug.tsx:435-438`

```tsx
function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}
```

**Problem.** `formatMs(0)` → `"0.0ms"`, but `formatMs(11)` → `"11ms"` and `formatMs(5)` → `"5.0ms"`. Zero is a plausible value here (e.g. sub-millisecond p50 from a fast local call rounded down, or an empty-bucket edge case), and it's the only whole number that renders with a decimal. The analytics panel renders p50/p95/p99 unconditionally when `hasTraffic` is true — there's no guard that p95 is non-null/non-zero when calls > 0.

**Impact.** Minor — visually inconsistent units in the latency card.

**Fix.**

```suggestion
function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms === 0) return "0ms";
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}
```

### [SEV: P3] `credits` NumberTicker shows raw integer; same panel formats `row.credits.toLocaleString()`

**Location** — `apps/web/src/routes/app/projects/$projectSlug.tsx:485-490` vs `:589`

```tsx
<CardTitle className="text-2xl tabular-nums">
  <NumberTicker value={analytics.credits} />
</CardTitle>
```
…while in the per-endpoint table in the same component:
```tsx
<td className="px-2 py-2.5 text-right tabular-nums">
  {row.credits.toLocaleString()}
</td>
```

**Problem.** The headline "Credits earned" stat animates to `analytics.credits` as a raw number (e.g. `1243890`), while the breakdown table 30 lines below formats the same unit with `toLocaleString()` (`1,243,890`). Inconsistent number formatting within one panel.

**Impact.** Cosmetic, but the headline number is the most-glanced figure in the panel.

**Fix.** Either format inside `NumberTicker` (if it accepts a formatter prop) or render `{analytics.credits.toLocaleString()}` for the static value when not animating. If `NumberTicker` can't format, drop it for credits and use `toLocaleString()` to match the table.

### [SEV: P3] `copySecret` setTimeout hardcodes `1500ms` and leaks on unmount

**Location** — `apps/web/src/components/project-settings-panel.tsx:412-419`

```tsx
async function copySecret() {
  if (!endpoint?.secret) return;
  try {
    await navigator.clipboard.writeText(endpoint.secret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 1500);
  } catch {
    toast.error("Could not copy secret");
  }
}
```

**Problem.** Two issues:
1. `1500` is a hardcoded magic number. The project rule says *"all animation from src/lib/motion.ts / CSS vars"* — `motion.ts` exports `DUR` and the CSS layer exposes `--dur-*` vars (verified in `apps/web/src/styles.css:48-50`). The copy-reset should pull from one of those (or a named constant), not an inline literal.
2. The `setTimeout` is never cleared. If the component unmounts inside that 1500ms window (e.g. user toggles visibility from the header, navigation, tab switch), `setCopiedSecret(false)` fires against an unmounted instance. React 18 no longer warns, but it's still an untracked timer.

**Impact.** Minor; violates the "animations from motion.ts" rule and leaves an untracked timer in a component that frequently mounts/unmounts with tab switches.

**Fix.** Store the timer in a ref, clear on unmount, and use a motion token:

```suggestion
const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
useEffect(() => () => {
  if (copyResetRef.current) clearTimeout(copyResetRef.current);
}, []);
async function copySecret() {
  if (!endpoint?.secret) return;
  try {
    await navigator.clipboard.writeText(endpoint.secret);
    setCopiedSecret(true);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(
      () => setCopiedSecret(false),
      1500,
    );
  } catch {
    toast.error("Could not copy secret");
  }
}
```
(And ideally replace `1500` with a token from `motion.ts`.)

## Summary

- **7 findings**: 0 × P0, 1 × P1, 2 × P2, 4 × P3.
- **Top 3 to fix before merge:**
  1. **[P1] Realtime `useEffect` overwrites unsaved edits** in both the details form and the webhook URL form — silent data loss the moment any concurrent mutation touches the project/endpoint doc.
  2. **[P2] Webhook card flashes "Create endpoint" on every visit** — `useQuery` + `data ?? null` instead of a skeleton; violates the layout-stable-skeleton rule.
  3. **[P2] Raw `<textarea>` duplicates stock `Textarea`** — drifts from `ui/textarea.tsx`, drops dark-mode + `aria-invalid` styling; should use the stock component.

**Other notes (not findings, do not require action):**
- The duplicate visibility dialog (one in `$projectSlug.tsx` header, one in `project-settings-panel.tsx`) is intentional convenience and uses the same mutation path — not dead code.
- `humanError` is used consistently on every `onError`; no internal-error leakage observed.
- Color usage is clean — only semantic tokens (`bg-primary/80`, `text-destructive`, `border-destructive/40`, `text-muted-foreground`, `text-success-foreground`, `border-border`). No raw Tailwind colors.
- Analytics bar-chart transition correctly uses CSS vars (`duration-[var(--dur-fast)] ease-[var(--ease)]`), confirmed defined in `styles.css:48,50`.
- `saveDetails` correctly uses `.mutate()` in a handler (not `.mutateAsync()`), per the mutation rule.
- View-transition names on the project status badge and title (`viewTransitionName: \`project-status-${slug}\``, `project-title-${slug}`) wire up list→detail morph correctly; tab switches inside the detail page are not list→detail and reasonably don't morph.
