import { describe, expect, it } from "vitest";

import { canTestSavedDraft } from "./spec-readiness";

describe("canTestSavedDraft", () => {
  it("keeps Test disabled through an import/autosave race", () => {
    const imported = '{"openapi":"3.1.0","info":{"title":"Imported"}}';
    const priorSaved = '{"openapi":"3.1.0","info":{"title":"Prior"}}';

    // Import changes the editor before the delayed autosave response arrives.
    expect(
      canTestSavedDraft(
        imported,
        { text: priorSaved, hash: "prior-hash" },
        false,
        false,
      ),
    ).toBe(false);

    // The delayed response confirms the old content, never the imported text.
    expect(
      canTestSavedDraft(
        imported,
        { text: priorSaved, hash: "prior-hash" },
        true,
        false,
      ),
    ).toBe(false);

    // Only the import's own server-confirmed hash enables the connection test.
    expect(
      canTestSavedDraft(
        imported,
        { text: imported, hash: "import-hash" },
        false,
        false,
      ),
    ).toBe(true);
  });
});
