ALTER TABLE `openapi_schema_version` RENAME COLUMN "version_number" TO "version";--> statement-breakpoint
DROP INDEX `openapi_schema_version_number_index`;--> statement-breakpoint
CREATE UNIQUE INDEX `openapi_schema_version_number_index` ON `openapi_schema_version` (`openapi_schema_id`,`version`);--> statement-breakpoint
ALTER TABLE `openapi_schema_version` ALTER COLUMN "version" TO "version" text NOT NULL;--> statement-breakpoint
ALTER TABLE `openapi_schema` ALTER COLUMN "draft" TO "draft" text NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ALTER COLUMN "description" TO "description" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `project` ALTER COLUMN "documentation" TO "documentation" text NOT NULL DEFAULT '';
