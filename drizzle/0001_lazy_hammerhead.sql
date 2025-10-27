DROP INDEX "api_spec_hash_unique";--> statement-breakpoint
DROP INDEX "organization_slug_unique";--> statement-breakpoint
DROP INDEX "session_token_unique";--> statement-breakpoint
DROP INDEX "user_email_unique";--> statement-breakpoint
ALTER TABLE `api_endpoint` ALTER COLUMN "security" TO "security" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `api_spec_hash_unique` ON `api_spec` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
ALTER TABLE `api_endpoint` ALTER COLUMN "tags" TO "tags" text NOT NULL;--> statement-breakpoint
ALTER TABLE `apikey` ALTER COLUMN "enabled" TO "enabled" integer NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE `apikey` ALTER COLUMN "rate_limit_enabled" TO "rate_limit_enabled" integer NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE `apikey` ALTER COLUMN "rate_limit_max" TO "rate_limit_max" integer NOT NULL DEFAULT 10;--> statement-breakpoint
ALTER TABLE `apikey` ALTER COLUMN "rate_limit_time_window" TO "rate_limit_time_window" integer NOT NULL DEFAULT 86400000;--> statement-breakpoint
ALTER TABLE `apikey` ALTER COLUMN "request_count" TO "request_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `organization` ALTER COLUMN "slug" TO "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE `project_category` ALTER COLUMN "weight" TO "weight" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `project_member` ALTER COLUMN "permissions" TO "permissions" text NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ALTER COLUMN "two_factor_enabled" TO "two_factor_enabled" integer NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `active_organization_id` text REFERENCES organization(id);