CREATE TABLE `inmate_import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`row_no` integer NOT NULL,
	`raw_json` text,
	`result` text NOT NULL,
	`message` text,
	`inmate_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `inmate_import_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_import_rows_run` ON `inmate_import_rows` (`run_id`,`row_no`);--> statement-breakpoint
CREATE TABLE `inmate_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`source` text NOT NULL,
	`file_key` text,
	`status` text DEFAULT 'dry_run' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`rows_total` integer DEFAULT 0 NOT NULL,
	`rows_created` integer DEFAULT 0 NOT NULL,
	`rows_updated` integer DEFAULT 0 NOT NULL,
	`rows_skipped` integer DEFAULT 0 NOT NULL,
	`rows_errored` integer DEFAULT 0 NOT NULL,
	`error_report_key` text,
	`run_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_import_runs_prison` ON `inmate_import_runs` (`prison_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `inmates` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`work_division_id` text,
	`inmate_code` text NOT NULL,
	`full_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`released_at` integer,
	`external_id` text,
	`external_source` text,
	`synced_at` integer,
	`sync_hash` text,
	`is_locally_edited` integer DEFAULT false NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`work_division_id`) REFERENCES `work_divisions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inmates_prison_code` ON `inmates` (`prison_id`,`inmate_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inmates_external` ON `inmates` (`external_source`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_inmates_external` ON `inmates` (`external_source`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_inmates_prison_zone` ON `inmates` (`prison_id`,`zone_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_inmates_name` ON `inmates` (`full_name`);--> statement-breakpoint
CREATE TABLE `prisons` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name_th` text NOT NULL,
	`name_en` text,
	`address` text,
	`province` text,
	`phone` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_prisons_code` ON `prisons` (`code`);--> statement-breakpoint
CREATE TABLE `work_divisions` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_work_divisions_prison_name` ON `work_divisions` (`prison_id`,`name`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_zones_prison_name` ON `zones` (`prison_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_zones_prison` ON `zones` (`prison_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `customer_inmates` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`inmate_id` text NOT NULL,
	`relationship` text,
	`verify_status` text DEFAULT 'pending' NOT NULL,
	`verified_at` integer,
	`verified_by` text,
	`reject_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_inmates` ON `customer_inmates` (`customer_id`,`inmate_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_inmates_inmate` ON `customer_inmates` (`inmate_id`,`verify_status`);--> statement-breakpoint
CREATE TABLE `customer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`revoked_at` integer,
	`replaced_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_sessions_token` ON `customer_sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_customer_sessions_customer` ON `customer_sessions` (`customer_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`phone` text NOT NULL,
	`line_id_text` text,
	`line_user_id` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`password_changed_at` integer,
	`must_change_password` integer DEFAULT false NOT NULL,
	`is_blocked` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_username` ON `customers` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_line_user_id` ON `customers` (`line_user_id`);--> statement-breakpoint
CREATE INDEX `idx_customers_name` ON `customers` (`full_name`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`email` text,
	`role` text NOT NULL,
	`prison_id` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`password_changed_at` integer,
	`must_change_password` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_username` ON `staff` (`username`);--> statement-breakpoint
CREATE INDEX `idx_staff_prison` ON `staff` (`prison_id`,`role`);--> statement-breakpoint
CREATE TABLE `staff_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`revoked_at` integer,
	`replaced_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_sessions_token` ON `staff_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_staff_sessions_staff` ON `staff_sessions` (`staff_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`prison_id` text,
	`before_json` text,
	`after_json` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_logs` (`entity`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_logs` (`actor_type`,`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `counters` (
	`scope` text NOT NULL,
	`period` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_counters` ON `counters` (`scope`,`period`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text,
	`run_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`last_error` text,
	`result_json` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_claim` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_kind` ON `jobs` (`kind`,`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`audience` text NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`data_json` text,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`read_at` integer,
	`sent_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_recipient` ON `notifications` (`audience`,`recipient_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`blocked_until` integer
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limits_window` ON `rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`scope_id` text,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_settings_key_scope` ON `settings` (`key`,`scope`,`scope_id`);