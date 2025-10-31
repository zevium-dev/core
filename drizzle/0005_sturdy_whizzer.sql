DROP INDEX `project_slug_index`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_slug_organization_id_index` ON `project` (`slug`,`organization_id`);