CREATE TABLE `organization_user_permission` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`permission` text NOT NULL,
	`user_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_user_permission_organization_id_index` ON `organization_user_permission` (`organization_id`);--> statement-breakpoint
CREATE INDEX `organization_user_permission_user_id_index` ON `organization_user_permission` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_user_permission_unique_index` ON `organization_user_permission` (`organization_id`,`user_id`,`permission`);--> statement-breakpoint
CREATE TABLE `project_user_permission` (
	`id` text PRIMARY KEY NOT NULL,
	`permission` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_user_permission_project_id_index` ON `project_user_permission` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_user_permission_user_id_index` ON `project_user_permission` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_user_permission_unique_index` ON `project_user_permission` (`project_id`,`user_id`,`permission`);--> statement-breakpoint
CREATE TABLE `user_permission` (
	`id` text PRIMARY KEY NOT NULL,
	`permission` text NOT NULL,
	`user_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_permission_user_id_index` ON `user_permission` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_permission_user_permission_unique_index` ON `user_permission` (`user_id`,`permission`);