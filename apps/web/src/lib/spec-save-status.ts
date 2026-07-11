export type SaveStatusKind =
  "saved" | "saving" | "unsaved" | "fix-errors" | "idle";

export type SaveStatusInput = {
  dirty: boolean;
  saving: boolean;
  hasClientErrors: boolean;
  lastSavedAt: number | null;
  now: number;
};

export type SaveStatus = {
  kind: SaveStatusKind;
  label: string;
};

export function formatSavedAgo(lastSavedAt: number, now: number): string {
  const deltaMs = Math.max(0, now - lastSavedAt);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 5) return "saved just now";
  if (sec < 60) return `saved ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `saved ${min}m ago`;
  const hr = Math.floor(min / 60);
  return `saved ${hr}h ago`;
}

export function deriveSaveStatus(input: SaveStatusInput): SaveStatus {
  if (input.saving) {
    return { kind: "saving", label: "saving…" };
  }
  if (input.hasClientErrors && input.dirty) {
    return { kind: "fix-errors", label: "fix errors to save" };
  }
  if (input.dirty) {
    return { kind: "unsaved", label: "unsaved" };
  }
  if (input.lastSavedAt !== null && input.lastSavedAt > 0) {
    return {
      kind: "saved",
      label: formatSavedAgo(input.lastSavedAt, input.now),
    };
  }
  return { kind: "idle", label: "not saved yet" };
}
