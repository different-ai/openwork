CREATE TABLE `org_subscriptions` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64),
	`type` enum('inference') NOT NULL,
	`status` enum('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused','expired') NOT NULL DEFAULT 'incomplete',
	`stripe_customer_id` varchar(255) NOT NULL,
	`stripe_subscription_id` varchar(255) NOT NULL,
	`stripe_price_id` varchar(255),
	`stripe_subscription_item_id` varchar(255),
	`quantity` int NOT NULL DEFAULT 0,
	`current_period_start` timestamp(3),
	`current_period_end` timestamp(3),
	`cancel_at_period_end` boolean NOT NULL DEFAULT false,
	`canceled_at` timestamp(3),
	`ended_at` timestamp(3),
	`last_event_id` varchar(255),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `org_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `org_subscriptions_subscription_id` UNIQUE(`stripe_subscription_id`),
	CONSTRAINT `org_subscriptions_org_type` UNIQUE(`organization_id`,`type`)
);
--> statement-breakpoint
CREATE INDEX `org_subscriptions_organization_id` ON `org_subscriptions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `org_subscriptions_customer_id` ON `org_subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `org_subscriptions_status` ON `org_subscriptions` (`status`);