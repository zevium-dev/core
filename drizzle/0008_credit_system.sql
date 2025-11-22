-- Credit balance per user
CREATE TABLE IF NOT EXISTS `credit_balance` (
  `user_id` text PRIMARY KEY NOT NULL,
  `balance_cents` integer NOT NULL DEFAULT 0,
  `currency` text NOT NULL DEFAULT 'usd',
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `credit_balance_user_id_index` ON `credit_balance` (`user_id`);

-- Credit ledger
CREATE TABLE IF NOT EXISTS `credit_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `type` text NOT NULL,
  `reference` text,
  `description` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS `credit_ledger_user_id_index` ON `credit_ledger` (`user_id`);

