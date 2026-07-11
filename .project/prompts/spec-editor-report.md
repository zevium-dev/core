Read-only task — do NOT modify any files.

Project: /home/tnfssc/Code/zevium. Frontend apps/web (TanStack Start), backend convex/. Publishers create projects and upload/edit OpenAPI specs; pricing lives in x-zevium-cost extensions; publish makes an immutable version.

TASK: document the CURRENT publisher spec-creation/editing experience in full so a redesign can be planned.

1. Find all publisher project + spec screens under apps/web/src/routes/ (likely /app/projects/...). List every file involved (routes, components, spec editor component).
2. Describe the exact current flow step-by-step as a user experiences it: create project → add spec → edit → validate → publish. What inputs, what UI (textarea? code editor? file upload?), what validation feedback, what preview.
3. List convex functions involved (projects/specs CRUD, publish pipeline) with file:line and their args — so redesign knows the API surface.
4. List what packages/shared provides for spec parsing/validation (x-zevium-* extraction).
5. Honest UX critique: friction points, missing affordances (no syntax highlight? no validation-as-you-type? no pricing preview? no diff between versions? no import from URL?).

Output contract — end with:
FILES: <list>
CURRENT FLOW: <numbered steps>
API SURFACE: <list>
CRITIQUE: <bullet list>
End with DONE.
