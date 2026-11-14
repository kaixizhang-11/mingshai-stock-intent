ALTER TABLE `market_cache` ADD COLUMN `lease_until` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `market_cache` ADD COLUMN `lease_owner` text;
--> statement-breakpoint
CREATE INDEX `request_rates_period_idx` ON `request_rates` (`period`);
