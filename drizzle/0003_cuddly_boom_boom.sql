CREATE TABLE `openapi_schema` (
	`created_at` integer NOT NULL,
	`draft` text DEFAULT '' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`project_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `openapi_schema_project_id_index` ON `openapi_schema` (`project_id`);--> statement-breakpoint
CREATE TABLE `openapi_schema_version` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`openapi_schema_id` text NOT NULL,
	`spec` text NOT NULL,
	`updated_at` integer NOT NULL,
	`version_number` integer NOT NULL,
	FOREIGN KEY (`openapi_schema_id`) REFERENCES `openapi_schema`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `openapi_schema_version_openapi_schema_id_index` ON `openapi_schema_version` (`openapi_schema_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `openapi_schema_version_number_index` ON `openapi_schema_version` (`openapi_schema_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `organization_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`tag_name` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_name`) REFERENCES `tag`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_tag_organization_id_index` ON `organization_tag` (`organization_id`);--> statement-breakpoint
CREATE INDEX `organization_tag_tag_name_index` ON `organization_tag` (`tag_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_tag_unique_index` ON `organization_tag` (`organization_id`,`tag_name`);--> statement-breakpoint
CREATE TABLE `project_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`tag_name` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_name`) REFERENCES `tag`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_tag_project_id_index` ON `project_tag` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_tag_tag_name_index` ON `project_tag` (`tag_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_tag_unique_index` ON `project_tag` (`project_id`,`tag_name`);--> statement-breakpoint
CREATE TABLE `tag` (
	`created_at` integer NOT NULL,
	`created_by` text,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_unique` ON `tag` (`name`);--> statement-breakpoint
CREATE INDEX `tag_created_by_index` ON `tag` (`created_by`);--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_index` ON `tag` (`name`);--> statement-breakpoint
DROP TABLE `api_endpoint`;--> statement-breakpoint
DROP TABLE `api_spec`;--> statement-breakpoint
DROP TABLE `project_category`;--> statement-breakpoint
DROP TABLE `project_member`;--> statement-breakpoint
ALTER TABLE `project` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `project` ADD `documentation` text;--> statement-breakpoint
CREATE UNIQUE INDEX `project_slug_unique` ON `project` (`slug`);--> statement-breakpoint
CREATE INDEX `project_organization_id_index` ON `project` (`organization_id`);--> statement-breakpoint
CREATE INDEX `project_created_at_index` ON `project` (`created_at`);--> statement-breakpoint
CREATE INDEX `project_updated_at_index` ON `project` (`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_slug_index` ON `project` (`slug`);--> statement-breakpoint
CREATE TABLE `project_new` (
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`description` text,
	`documentation` text,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`name` text NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	`visibility` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `project_new` SELECT `created_at`, `deleted_at`, `description`, `documentation`, `id`, `metadata`, `name`, `organization_id`, `slug`, `status`, `updated_at`, `visibility` FROM `project`;--> statement-breakpoint
DROP TABLE `project`;--> statement-breakpoint
ALTER TABLE `project_new` RENAME TO `project`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_slug_unique` ON `project` (`slug`);--> statement-breakpoint
CREATE INDEX `project_organization_id_index` ON `project` (`organization_id`);--> statement-breakpoint
CREATE INDEX `project_created_at_index` ON `project` (`created_at`);--> statement-breakpoint
CREATE INDEX `project_updated_at_index` ON `project` (`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_slug_index` ON `project` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique_index` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `apikey_user_id_index` ON `apikey` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_key_index` ON `apikey` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_prefix_index` ON `apikey` (`prefix`);--> statement-breakpoint
CREATE INDEX `invitation_inviter_id_index` ON `invitation` (`inviter_id`);--> statement-breakpoint
CREATE INDEX `invitation_organization_id_index` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_organization_id_index` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_user_id_index` ON `member` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_organization_user_unique_index` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_index` ON `organization` (`slug`);--> statement-breakpoint
CREATE INDEX `session_user_id_index` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_expires_at_index` ON `session` (`expires_at`);--> statement-breakpoint
CREATE INDEX `two_factor_user_id_index` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_email_index` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_preference_user_id_index` ON `user_preference` (`user_id`);
