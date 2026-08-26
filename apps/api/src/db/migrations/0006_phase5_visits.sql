CREATE TABLE `visit_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_no` text NOT NULL,
	`customer_id` text NOT NULL,
	`inmate_id` text NOT NULL,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`schedule_day_id` text NOT NULL,
	`visit_date` text NOT NULL,
	`round_id` text NOT NULL,
	`session` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`starts_at` integer NOT NULL,
	`round_label_snapshot` text NOT NULL,
	`zone_name_snapshot` text,
	`inmate_code_snapshot` text NOT NULL,
	`inmate_name_snapshot` text NOT NULL,
	`visitor_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`line_id_text` text,
	`visitor_count` integer DEFAULT 1 NOT NULL,
	`note` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`cancelled_reason` text,
	`cancelled_at` integer,
	`checked_in_at` integer,
	`reminded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`schedule_day_id`) REFERENCES `visit_schedule_days`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`round_id`) REFERENCES `visit_rounds`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_visit_bookings_no` ON `visit_bookings` (`booking_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_visit_bookings_inmate_day` ON `visit_bookings` (`inmate_id`,`visit_date`) WHERE status in ('pending','confirmed','checked_in');--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_day` ON `visit_bookings` (`schedule_day_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_gate` ON `visit_bookings` (`prison_id`,`visit_date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_customer` ON `visit_bookings` (`customer_id`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_inmate` ON `visit_bookings` (`inmate_id`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_reminder` ON `visit_bookings` (`status`,`starts_at`,`reminded_at`);--> statement-breakpoint
CREATE TABLE `visit_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`round_no` integer NOT NULL,
	`label` text NOT NULL,
	`session` text DEFAULT 'morning' NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_visit_rounds_no` ON `visit_rounds` (`prison_id`,`round_no`);--> statement-breakpoint
CREATE INDEX `idx_visit_rounds_prison` ON `visit_rounds` (`prison_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `visit_schedule_days` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`date` text NOT NULL,
	`round_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`capacity` integer DEFAULT 20 NOT NULL,
	`booked_count` integer DEFAULT 0 NOT NULL,
	`is_closed` integer DEFAULT false NOT NULL,
	`note` text,
	`source` text DEFAULT 'template' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`round_id`) REFERENCES `visit_rounds`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_visit_days_capacity" CHECK(booked_count >= 0 AND booked_count <= capacity)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_visit_days_cell` ON `visit_schedule_days` (`prison_id`,`date`,`round_id`,`zone_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_days_grid` ON `visit_schedule_days` (`prison_id`,`date`,`round_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_days_zone` ON `visit_schedule_days` (`prison_id`,`zone_id`,`date`);--> statement-breakpoint
CREATE TABLE `visit_schedule_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`round_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`capacity` integer DEFAULT 20 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`round_id`) REFERENCES `visit_rounds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_visit_templates_cell` ON `visit_schedule_templates` (`prison_id`,`weekday`,`round_id`,`zone_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_templates_prison` ON `visit_schedule_templates` (`prison_id`,`weekday`);