CREATE TABLE `gateway_routers` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`configuration` json NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_routers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_routers_owner` ON `gateway_routers` (`organization_id`,`created_by_org_membership_id`);