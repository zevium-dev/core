DROP INDEX `organization_polar_customer_id_index`;--> statement-breakpoint
ALTER TABLE `organization` DROP COLUMN `polar_billing_email`;--> statement-breakpoint
ALTER TABLE `organization` DROP COLUMN `polar_customer_id`;--> statement-breakpoint
-- Replace the org-scoped one-key-per-creator guard with a per-user guard.
-- (apiKey plugin now uses `references: "user"`, so reference_id = userId.)
DROP INDEX `apikey_one_per_org_creator`;--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_one_per_user` ON `apikey` (`reference_id`) WHERE `reference_id` IS NOT NULL;