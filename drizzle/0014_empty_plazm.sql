CREATE TABLE `credit_ledger` (
	`amount_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	`description` text,
	`id` text PRIMARY KEY NOT NULL,
	`reference` text,
	`type` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credit_ledger_user_id_index` ON `credit_ledger` (`user_id`);--> statement-breakpoint
CREATE INDEX `credit_ledger_created_at_index` ON `credit_ledger` (`created_at`);