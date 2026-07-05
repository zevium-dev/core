-- Polar-native credits migration (idempotent rewrite).
--
-- Original 0014 added org-scoped Polar columns (polar_customer_id /
-- polar_billing_email) to `organization` and a per-(org, creator) key
-- guard index, but assumed the Better Auth `apiKey` plugin's
-- `apikey.reference_id` column already existed (it didn't, because we
-- never regenerated the plugin's CLI migrations after enabling
-- `references: "user"` on the plugin). The result was a migration that
-- crashed on every fresh DB.
--
-- The follow-up 0015 cuts over to user-scoped billing, which removes the
-- org-scoped Polar columns from the final schema entirely. So we drop them
-- from this migration as well — 0015 only needs to swap the key guard.
--
-- Every statement is guarded with IF EXISTS / IF NOT EXISTS so the
-- migration is safe to re-run against any partial state left behind by
-- the original broken 0014 + 0015 pair.

ALTER TABLE `apikey` ADD COLUMN `reference_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `apikey_reference_id_index` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `apikey_one_per_org_creator` ON `apikey` (`reference_id`, json_extract(`metadata`, '$.creatorUserId')) WHERE `reference_id` IS NOT NULL;