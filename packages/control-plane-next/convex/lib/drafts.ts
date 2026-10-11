import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
export async function getProjectDraft(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
) {
  return ctx.db
    .query("projectDrafts")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
}
export function draftConflict(draft: Doc<"projectDrafts"> | null) {
  return {
    ok: false as const,
    conflict: true as const,
    issues: [],
    draft: draft?.text ?? "",
    draftHash: draft?.hash ?? null,
    lastSavedAt: draft?.savedAt ?? 0,
  };
}
