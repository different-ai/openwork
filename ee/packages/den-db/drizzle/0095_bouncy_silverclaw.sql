CREATE TABLE `mcp_connection_attempt` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`identity_binding` varchar(64) NOT NULL,
	`state_hash` varchar(64) NOT NULL,
	`status` enum('pending','authorized','failed') NOT NULL,
	`diagnostic` json,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `mcp_connection_attempt_id` PRIMARY KEY(`id`),
	CONSTRAINT `mcp_connection_attempt_state` UNIQUE(`state_hash`)
);
--> statement-breakpoint
CREATE INDEX `mcp_connection_attempt_owner` ON `mcp_connection_attempt` (`organization_id`,`org_membership_id`,`connection_id`);--> statement-breakpoint
CREATE INDEX `mcp_connection_attempt_expiry` ON `mcp_connection_attempt` (`expires_at`);