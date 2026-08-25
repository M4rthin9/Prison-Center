CREATE TABLE `letter_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`letter_id` text NOT NULL,
	`image_key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`letter_id`) REFERENCES `letters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_letter_attachments_letter` ON `letter_attachments` (`letter_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `letter_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_no` text NOT NULL,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`zone_name_snapshot` text,
	`letter_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`format` text,
	`pdf_key` text,
	`last_error` text,
	`generated_by` text,
	`generated_at` integer,
	`printed_by` text,
	`printed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_letter_batches_no` ON `letter_batches` (`batch_no`);--> statement-breakpoint
CREATE INDEX `idx_letter_batches_prison` ON `letter_batches` (`prison_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `letter_credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`inmate_id` text,
	`prison_id` text,
	`direction` text NOT NULL,
	`delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_credit_ledger_latest` ON `letter_credit_ledger` (`customer_id`,`direction`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_credit_ledger_ref` ON `letter_credit_ledger` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `letter_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`price_satang` integer NOT NULL,
	`quota` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_letter_packages_name` ON `letter_packages` (`prison_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_letter_packages_offer` ON `letter_packages` (`prison_id`,`direction`,`is_active`,`sort_order`);--> statement-breakpoint
CREATE TABLE `letter_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_no` text NOT NULL,
	`customer_id` text NOT NULL,
	`package_id` text,
	`prison_id` text NOT NULL,
	`package_name_snapshot` text NOT NULL,
	`direction` text NOT NULL,
	`quota` integer NOT NULL,
	`price_satang` integer NOT NULL,
	`payment_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`package_id`) REFERENCES `letter_packages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_letter_purchases_no` ON `letter_purchases` (`purchase_no`);--> statement-breakpoint
CREATE INDEX `idx_letter_purchases_customer` ON `letter_purchases` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letter_purchases_prison` ON `letter_purchases` (`prison_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letter_purchases_payment` ON `letter_purchases` (`payment_id`);--> statement-breakpoint
CREATE TABLE `letters` (
	`id` text PRIMARY KEY NOT NULL,
	`letter_no` text NOT NULL,
	`direction` text NOT NULL,
	`sender_customer_id` text,
	`sender_inmate_id` text,
	`recipient_inmate_id` text,
	`recipient_customer_id` text,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`zone_name_snapshot` text,
	`inmate_code_snapshot` text,
	`inmate_name_snapshot` text,
	`customer_name_snapshot` text,
	`body_text` text DEFAULT '' NOT NULL,
	`scan_image_key` text,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`batch_id` text,
	`queued_at` integer,
	`printed_at` integer,
	`printed_by` text,
	`dispatched_at` integer,
	`delivered_at` integer,
	`reply_to_letter_id` text,
	`rejected_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`sender_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sender_inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `letter_batches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_letters_letter_no` ON `letters` (`letter_no`);--> statement-breakpoint
CREATE INDEX `idx_letters_print_queue` ON `letters` (`prison_id`,`zone_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letters_sender` ON `letters` (`sender_customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letters_recipient` ON `letters` (`recipient_customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letters_inmate` ON `letters` (`recipient_inmate_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letters_batch` ON `letters` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_letters_reply_to` ON `letters` (`reply_to_letter_id`);