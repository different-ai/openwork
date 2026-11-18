-- One idempotent statement per table, indexes inline: PlanetScale applies DDL
-- outside the transaction (see 0145).
CREATE TABLE IF NOT EXISTS `mcp_registration_event` (
	`id` varchar(64) NOT NULL,
	`issuer` varchar(512) NOT NULL,
	`preset_id` varchar(64),
	`source` enum('sign_in','probe') NOT NULL,
	`outcome` enum('registered_client_metadata','registered_dynamic','refused','no_registration_method','metadata_only','no_auth','unreachable') NOT NULL,
	`organization_id` varchar(64),
	`connection_id` varchar(64),
	`http_status` int,
	`diagnostic_code` varchar(96),
	`reference` varchar(96),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_registration_event_id` PRIMARY KEY(`id`),
	INDEX `mcp_registration_event_issuer_created` (`issuer`,`created_at`),
	INDEX `mcp_registration_event_created` (`created_at`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_registration_status` (
	`id` varchar(64) NOT NULL,
	`issuer` varchar(512) NOT NULL,
	`preset_id` varchar(64),
	`server_url` varchar(2048),
	`status` enum('client_metadata','dynamic_open','dynamic_refused','requires_client','no_auth','unknown') NOT NULL DEFAULT 'unknown',
	`client_metadata_supported` boolean,
	`dynamic_registration_supported` boolean,
	`registration_endpoint` varchar(2048),
	`last_source` enum('sign_in','probe'),
	`last_http_status` int,
	`last_diagnostic_code` varchar(96),
	`last_reference` varchar(96),
	`accepted_count` int NOT NULL DEFAULT 0,
	`refused_count` int NOT NULL DEFAULT 0,
	`last_accepted_at` timestamp(3),
	`last_refused_at` timestamp(3),
	`last_observed_at` timestamp(3),
	`last_probed_at` timestamp(3),
	`probe_lease_until` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_registration_status_id` PRIMARY KEY(`id`),
	CONSTRAINT `mcp_registration_status_issuer` UNIQUE(`issuer`),
	INDEX `mcp_registration_status_status` (`status`)
);
