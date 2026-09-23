CREATE TABLE `organization_web_origin` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`origin` varchar(255) NOT NULL,
	`created_by_org_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `organization_web_origin_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_web_origin_org_origin` UNIQUE(`organization_id`,`origin`)
);
--> statement-breakpoint
CREATE INDEX `organization_web_origin_origin` ON `organization_web_origin` (`origin`);