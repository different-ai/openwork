CREATE TABLE `external_mcp_oauth_pending_grant` (
	`state_hash` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`code_verifier` text NOT NULL,
	`org_oauth_client_id` varchar(64) NOT NULL,
	`client_revision` int NOT NULL,
	`diagnostic_attempt_id` varchar(64),
	`diagnostic_generation` int,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `external_mcp_oauth_pending_grant_state_hash` PRIMARY KEY(`state_hash`)
);
--> statement-breakpoint
CREATE TABLE `mcp_diagnostic_attempt` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`status` enum('running','waiting_for_authorization','succeeded','failed','expired') NOT NULL DEFAULT 'running',
	`highest_health_level` enum('configured','reachable','authorized','protocol_ready','catalog_ready') NOT NULL DEFAULT 'configured',
	`first_failed_phase` enum('CONFIGURATION','NETWORK_DNS','NETWORK_TCP','NETWORK_TLS','HTTP_ROUTING','AUTH_RESOURCE_DISCOVERY','AUTH_ISSUER_DISCOVERY','AUTH_CLIENT_REGISTRATION','AUTH_USER_OR_WORKLOAD','AUTH_TOKEN_ACQUISITION','AUTH_RESOURCE_VALIDATION','MCP_TRANSPORT','MCP_VERSION','MCP_INITIALIZE','MCP_INITIALIZED','MCP_TOOL_DISCOVERY','MCP_TOOL_EXECUTION','PROVIDER_AUTHORIZATION','PROVIDER_EXECUTION','CONTINUITY_REFRESH','CONTINUITY_SESSION','SHUTDOWN'),
	`first_failure_category` varchar(128),
	`first_failure_message` text,
	`action_owner` enum('openwork','network_admin','provider_admin','organization_admin','member'),
	`operator_action` varchar(128),
	`authorization_generation` int NOT NULL DEFAULT 0,
	`authorization_claim_id` varchar(64),
	`authorization_lease_expires_at` timestamp(3),
	`last_sequence` int NOT NULL DEFAULT 0,
	`started_at` timestamp(3) NOT NULL DEFAULT (now()),
	`completed_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `mcp_diagnostic_attempt_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mcp_diagnostic_event` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`attempt_id` varchar(64) NOT NULL,
	`sequence` int NOT NULL,
	`phase` enum('CONFIGURATION','NETWORK_DNS','NETWORK_TCP','NETWORK_TLS','HTTP_ROUTING','AUTH_RESOURCE_DISCOVERY','AUTH_ISSUER_DISCOVERY','AUTH_CLIENT_REGISTRATION','AUTH_USER_OR_WORKLOAD','AUTH_TOKEN_ACQUISITION','AUTH_RESOURCE_VALIDATION','MCP_TRANSPORT','MCP_VERSION','MCP_INITIALIZE','MCP_INITIALIZED','MCP_TOOL_DISCOVERY','MCP_TOOL_EXECUTION','PROVIDER_AUTHORIZATION','PROVIDER_EXECUTION','CONTINUITY_REFRESH','CONTINUITY_SESSION','SHUTDOWN') NOT NULL,
	`outcome` enum('running','passed','waiting','failed','skipped') NOT NULL,
	`elapsed_ms` int NOT NULL,
	`phase_duration_ms` int,
	`health_level` enum('configured','reachable','authorized','protocol_ready','catalog_ready') NOT NULL,
	`message_safe` varchar(512) NOT NULL,
	`category` varchar(128),
	`retryable` boolean,
	`action_owner` enum('openwork','network_admin','provider_admin','organization_admin','member'),
	`operator_action` varchar(128),
	`evidence` json NOT NULL,
	`occurred_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_diagnostic_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `mcp_diagnostic_event_attempt_sequence` UNIQUE(`attempt_id`,`sequence`)
);
--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `oauth_registration_lease_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `oauth_registration_lease_expires_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `org_oauth_client` ADD `revision` int DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `emopg_organization_id` ON `external_mcp_oauth_pending_grant` (`organization_id`);--> statement-breakpoint
CREATE INDEX `emopg_connection_id` ON `external_mcp_oauth_pending_grant` (`external_mcp_connection_id`);--> statement-breakpoint
CREATE INDEX `emopg_expires_at` ON `external_mcp_oauth_pending_grant` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_attempt_organization_id` ON `mcp_diagnostic_attempt` (`organization_id`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_attempt_connection_id` ON `mcp_diagnostic_attempt` (`external_mcp_connection_id`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_attempt_expires_at` ON `mcp_diagnostic_attempt` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_event_organization_id` ON `mcp_diagnostic_event` (`organization_id`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_event_attempt_id` ON `mcp_diagnostic_event` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_event_attempt_time` ON `mcp_diagnostic_event` (`attempt_id`,`occurred_at`,`id`);