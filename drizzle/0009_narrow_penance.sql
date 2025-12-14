CREATE TABLE `project_secret` (
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`metadata` text,
	`name` text NOT NULL,
	`project_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_secret_project_id_index` ON `project_secret` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_secret_project_name_unique_index` ON `project_secret` (`project_id`,`name`);