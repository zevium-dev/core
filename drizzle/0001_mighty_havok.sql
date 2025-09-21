CREATE TABLE `cache` (
	`created_at` integer,
	`expires_at` integer NOT NULL,
	`key` text PRIMARY KEY NOT NULL,
	`updated_at` integer,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cache_key_unique` ON `cache` (`key`);