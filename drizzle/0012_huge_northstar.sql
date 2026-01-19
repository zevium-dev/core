CREATE TABLE `audit_log` (
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`organization_id` text,
	`project_id` text,
	`resource_id` text,
	`resource_type` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_log_user_id_index` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_log_organization_id_index` ON `audit_log` (`organization_id`);--> statement-breakpoint
CREATE INDEX `audit_log_project_id_index` ON `audit_log` (`project_id`);--> statement-breakpoint
CREATE INDEX `audit_log_resource_index` ON `audit_log` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_at_index` ON `audit_log` (`created_at`);