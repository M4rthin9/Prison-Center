CREATE TABLE `payment_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text,
	`rail` text NOT NULL,
	`display_name` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`biller_id` text,
	`terminal_suffix` text,
	`ref1_mode` text DEFAULT 'payment_no' NOT NULL,
	`ref2_mode` text DEFAULT 'none' NOT NULL,
	`target_type` text,
	`target_value` text,
	`bank_code` text,
	`account_no` text,
	`account_name` text,
	`supports_purposes_json` text NOT NULL,
	`amount_salt_enabled` integer DEFAULT false NOT NULL,
	`ttl_minutes` integer DEFAULT 30 NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payment_channels_name` ON `payment_channels` (`prison_id`,`display_name`);--> statement-breakpoint
CREATE INDEX `idx_payment_channels_prison` ON `payment_channels` (`prison_id`,`is_active`,`priority`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_no` text NOT NULL,
	`purpose` text NOT NULL,
	`purpose_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`rail` text NOT NULL,
	`customer_id` text NOT NULL,
	`prison_id` text NOT NULL,
	`amount_satang` integer NOT NULL,
	`amount_salt_satang` integer DEFAULT 0 NOT NULL,
	`charge_satang` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`qr_payload` text,
	`qr_ref1` text,
	`qr_ref2` text,
	`expires_at` integer,
	`slip_image_key` text,
	`slip_uploaded_at` integer,
	`trans_ref` text,
	`sending_bank` text,
	`receiving_bank` text,
	`transfer_amount_satang` integer,
	`transferred_at` integer,
	`verified_by` text,
	`verified_at` integer,
	`verify_method` text,
	`reject_reason` text,
	`settled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `payment_channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payments_payment_no` ON `payments` (`payment_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payments_trans_ref` ON `payments` (`trans_ref`);--> statement-breakpoint
CREATE INDEX `idx_payments_purpose` ON `payments` (`purpose`,`purpose_id`);--> statement-breakpoint
CREATE INDEX `idx_payments_status` ON `payments` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_payments_prison_created` ON `payments` (`prison_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_payments_customer` ON `payments` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_payments_channel_live` ON `payments` (`channel_id`,`status`,`charge_satang`);--> statement-breakpoint
CREATE INDEX `idx_payments_expiry` ON `payments` (`status`,`expires_at`);