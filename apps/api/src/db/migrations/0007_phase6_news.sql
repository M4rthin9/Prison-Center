CREATE TABLE `news` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`excerpt` text,
	`cover_image_key` text,
	`body_html` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` integer,
	`is_pinned` integer DEFAULT false NOT NULL,
	`author_staff_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`author_staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_news_slug` ON `news` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_news_feed` ON `news` (`status`,`prison_id`,`is_pinned`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_news_admin` ON `news` (`prison_id`,`created_at`);