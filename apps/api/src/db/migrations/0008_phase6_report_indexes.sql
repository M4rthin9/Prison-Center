CREATE INDEX `idx_orders_ordered_at` ON `orders` (`ordered_at`);--> statement-breakpoint
CREATE INDEX `idx_payments_created` ON `payments` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_deposits_created` ON `deposits` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_letters_created` ON `letters` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_date` ON `visit_bookings` (`visit_date`);