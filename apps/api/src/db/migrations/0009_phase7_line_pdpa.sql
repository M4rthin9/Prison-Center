CREATE TABLE `otp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`target` text NOT NULL,
	`reference` text NOT NULL,
	`code_hash` text NOT NULL,
	`channel` text DEFAULT 'console' NOT NULL,
	`customer_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`ip` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_otp_reference` ON `otp_challenges` (`reference`);--> statement-breakpoint
CREATE INDEX `idx_otp_target` ON `otp_challenges` (`target`,`purpose`,`expires_at`);--> statement-breakpoint
ALTER TABLE `customers` ADD `line_display_name` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `line_picture_url` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `line_linked_at` integer;--> statement-breakpoint
ALTER TABLE `customers` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `customers` ADD `anonymized_at` integer;--> statement-breakpoint
CREATE INDEX `idx_customers_closed` ON `customers` (`closed_at`);