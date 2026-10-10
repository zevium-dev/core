# Wisdom dir

Project config: `.bruv/settings.json`. `wisdomDir` points to `agents/notes/findings` (moved from `.project/findings` on 2026-10-10 with the [docs restructure](../decisions/2026-10-10-agents-notes-docs.md)).
Relative path resolves from project root, so other checkouts keep their own notes.
Run `/wisdom` in trusted project to check resolved path.
