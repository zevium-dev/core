-- Polar-native credits migration.
-- Drops the old self-managed user credit_ledger (1:1 user BITFIELD balance).
-- Replaces it with org-scoped Polar meter credits (one Polar customer per org,
-- one meter per org, credits granted on order.paid via meter_credit benefit,
-- deducted on events.ingest of "proxy_call" events).
--
-- New columns:
--   organization.polar_customer_id    -- Polar internal customer ID
--   organization.polar_billing_email  -- per-org deterministic email (org-${id}@billing.zevium.dev)
--   apikey.reference_id               -- already in plugin schema; index added for org-scoped lookup
--
-- New indexes:
--   organization_polar_customer_id_index  -- partial unique (skip NULLs so un-created customers don't collide)
--   apikey_reference_id_index             -- for `WHERE reference_id = ?` org-key lookups
--   apikey_one_per_org_creator            -- functional unique on (reference_id, json_extract(metadata,'$.creatorUserId'))

ALTER TABLE `organization` ADD `polar_billing_email` text;--> statement-breakpoint
ALTER TABLE `organization` ADD `polar_customer_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `organization_polar_customer_id_index` ON `organization` (`polar_customer_id`) WHERE `polar_customer_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `credit_ledger`;--> statement-breakpoint
CREATE INDEX `apikey_reference_id_index` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_one_per_org_creator` ON `apikey` (`reference_id`, json_extract(`metadata`, '$.creatorUserId')) WHERE `reference_id` IS NOT NULL;
