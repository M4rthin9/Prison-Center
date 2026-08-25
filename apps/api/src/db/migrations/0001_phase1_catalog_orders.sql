CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_categories_name` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`category_id` text,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price_satang` integer NOT NULL,
	`unit` text DEFAULT 'ชิ้น' NOT NULL,
	`image_key` text,
	`product_type` text DEFAULT 'packaged_goods' NOT NULL,
	`max_per_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_shop_sku` ON `products` (`shop_id`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_products_shop_cat` ON `products` (`shop_id`,`category_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `idx_products_name` ON `products` (`name`);--> statement-breakpoint
CREATE TABLE `shop_hours` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`opens_at` text NOT NULL,
	`closes_at` text NOT NULL,
	`is_open` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shop_hours_day` ON `shop_hours` (`shop_id`,`weekday`);--> statement-breakpoint
CREATE TABLE `shops` (
	`id` text PRIMARY KEY NOT NULL,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`name` text NOT NULL,
	`shop_type` text DEFAULT 'prison_products' NOT NULL,
	`description` text,
	`image_key` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shops_prison_name` ON `shops` (`prison_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_shops_prison` ON `shops` (`prison_id`,`is_active`,`sort_order`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`sku_snapshot` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`unit_snapshot` text NOT NULL,
	`category_name_snapshot` text,
	`unit_price_satang` integer NOT NULL,
	`qty` integer NOT NULL,
	`line_total_satang` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_order_items_order` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_order_items_product` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_no` text NOT NULL,
	`customer_id` text NOT NULL,
	`inmate_id` text NOT NULL,
	`shop_id` text NOT NULL,
	`prison_id` text NOT NULL,
	`zone_id` text,
	`zone_name_snapshot` text,
	`inmate_code_snapshot` text NOT NULL,
	`inmate_name_snapshot` text NOT NULL,
	`subtotal_satang` integer NOT NULL,
	`discount_satang` integer DEFAULT 0 NOT NULL,
	`total_satang` integer NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`fulfillment_status` text DEFAULT 'new' NOT NULL,
	`note` text,
	`cancel_reason` text,
	`ordered_at` integer NOT NULL,
	`paid_at` integer,
	`fulfilled_at` integer,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inmate_id`) REFERENCES `inmates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`prison_id`) REFERENCES `prisons`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_orders_order_no` ON `orders` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_orders_prison_date` ON `orders` (`prison_id`,`ordered_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_paystatus` ON `orders` (`payment_status`,`ordered_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_fulfillment` ON `orders` (`prison_id`,`fulfillment_status`,`ordered_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_customer` ON `orders` (`customer_id`,`ordered_at`);