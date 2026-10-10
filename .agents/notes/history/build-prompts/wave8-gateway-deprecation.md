Task: gateway serves RFC 8594 deprecation headers. Write scope: apps/gateway/src/ + gateway tests only.

Read first: AGENTS.md gateway rules, apps/gateway/src/spec-source.ts (published spec shape from convex specs.getPublishedForGateway — now includes deprecation metadata: deprecatedAt?, sunsetAt?, deprecationMessage?), apps/gateway/src/pipeline.ts (response path).

BUILD: when the served spec version is deprecated, add response headers on proxied responses: `Deprecation: @<unix-ts>` (deprecatedAt seconds), `Sunset: <HTTP-date>` (when sunsetAt set), `Link: <https://zevium.dev/catalogue/{orgSlug}/{projectSlug}>; rel="deprecation"`. Never block/buffer; headers only. Extend spec-source types + convex source parsing to carry the fields (edge cache include them).
TESTS: pipeline test — deprecated spec → headers present with correct values; non-deprecated → absent. Extend existing fixtures.
VERIFY: pnpm --filter @zevium/gateway typecheck && test green.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
