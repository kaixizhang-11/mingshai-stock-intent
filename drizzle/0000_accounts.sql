CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL UNIQUE,
  `password_salt` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `strategies` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `prompt` text NOT NULL,
  `conditions_json` text NOT NULL,
  `assumptions_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `strategies_user_updated_idx` ON `strategies` (`user_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `request_rates` (
  `key` text PRIMARY KEY NOT NULL,
  `period` integer NOT NULL,
  `count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_cache` (
  `id` integer PRIMARY KEY NOT NULL,
  `data_json` text NOT NULL,
  `fetched_at` integer NOT NULL
);
