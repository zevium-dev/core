-- User-scoped Polar billing cutover.
--
-- The new billing model keys Polar customers by userId (via the
-- @polar-sh/better-auth polar() plugin), so the org-scoped Polar columns
-- that the original 0014 added are gone by design — they were never
-- carried in the new schema. The only state change that survives from the
-- org-scoped era is the key guard: we swap the per-(org, creator) guard
-- (apikey_one_per_org_creator) for a per-user guard (apikey_one_per_user)
-- since the apiKey plugin is now configured with `references: "user"` and
-- `apikey.reference_id` is the user id.
--
-- The DROP is guarded with IF EXISTS so the migration is safe to re-run
-- against any partial state left behind by the original broken 0014 +
-- 0015 pair (where 0014 may have failed before creating the index).

DROP INDEX IF EXISTS `apikey_one_per_org_creator`;--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_one_per_user` ON `apikey` (`reference_id`) WHERE `reference_id` IS NOT NULL;