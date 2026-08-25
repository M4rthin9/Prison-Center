CREATE TABLE `deposit_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`inmate_id` text NOT NULL,
	`prison_id` text NOT NULL,
	`card_no` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`approved_by` text,
	`approved_at` integer,
	`reject_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deposit_cards_pair` ON `deposit_cards` (`customer_id`,`inmate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deposit_cards_no` ON `deposit_cards` (`card_no`);--> statement-breakpoint
CREATE INDEX `idx_deposit_cards_review` ON `deposit_cards` (`prison_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `deposits` (
	`id` text PRIMARY KEY NOT NULL,
	`deposit_no` text NOT NULL,
	`customer_id` text NOT NULL,
	`inmate_id` text NOT NULL,
	`card_id` text,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`zone_name_snapshot` text,
	`inmate_code_snapshot` text NOT NULL,
	`inmate_name_snapshot` text NOT NULL,
	`depositor_name` text NOT NULL,
	`amount_satang` integer NOT NULL,
	`payment_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`reject_reason` text,
	`deposited_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`card_id`) REFERENCES `deposit_cards`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deposits_deposit_no` ON `deposits` (`deposit_no`);--> statement-breakpoint
CREATE INDEX `idx_deposits_review` ON `deposits` (`prison_id`,`status`,`deposited_at`);--> statement-breakpoint
CREATE INDEX `idx_deposits_customer` ON `deposits` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_deposits_inmate` ON `deposits` (`inmate_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_deposits_payment` ON `deposits` (`payment_id`);