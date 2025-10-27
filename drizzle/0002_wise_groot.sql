DROP INDEX "api_spec_hash_unique";--> statement-breakpoint
DROP INDEX "organization_slug_unique";--> statement-breakpoint
DROP INDEX "session_token_unique";--> statement-breakpoint
DROP INDEX "user_email_unique";--> statement-breakpoint
ALTER TABLE `invitation` ALTER COLUMN "role" TO "role" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `api_spec_hash_unique` ON `api_spec` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
ALTER TABLE `member` ALTER COLUMN "role" TO "role" text NOT NULL;