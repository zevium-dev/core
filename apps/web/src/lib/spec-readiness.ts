export type ConfirmedDraft = {
  text: string;
  hash: string | null;
};

/** A connection test may only target the exact draft the server confirmed. */
export function canTestSavedDraft(
  editorText: string,
  confirmedDraft: ConfirmedDraft,
  saving: boolean,
  hasErrors: boolean,
): boolean {
  return (
    !saving &&
    !hasErrors &&
    confirmedDraft.hash !== null &&
    editorText === confirmedDraft.text
  );
}
