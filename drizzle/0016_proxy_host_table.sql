CREATE TABLE `proxy_host` (
	`created_at` integer NOT NULL,
	`host` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`unit_cost` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proxy_host_user_id_index` ON `proxy_host` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_host_user_host_unique_index` ON `proxy_host` (`user_id`,`host`);