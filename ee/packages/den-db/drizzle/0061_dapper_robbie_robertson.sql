CREATE TABLE `artifact_view_revision` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`artifact_view_id` varchar(64) NOT NULL,
	`created_by_member_id` varchar(64) NOT NULL,
	`react_source` mediumtext NOT NULL,
	`css_source` mediumtext NOT NULL,
	`compiled_html` mediumtext,
	`build_diagnostics` mediumtext NOT NULL,
	`build_status` enum('ready','failed') NOT NULL,
	`source_digest` varchar(71) NOT NULL,
	`resource_digest` varchar(71),
	`output_schema_digest` varchar(71) NOT NULL,
	`output_schema` mediumtext NOT NULL,
	`csp` json NOT NULL,
	`compiler_name` varchar(80) NOT NULL,
	`compiler_version` varchar(40) NOT NULL,
	`react_version` varchar(40) NOT NULL,
	`compiled_html_bytes` int unsigned,
	`retired_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `artifact_view_revision_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `artifact_view` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`config_object_id` varchar(64) NOT NULL,
	`owner_member_id` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` varchar(2000),
	`status` enum('active','retired') NOT NULL DEFAULT 'active',
	`active_revision_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `artifact_view_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `artifact_view_revision_view_created` ON `artifact_view_revision` (`artifact_view_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifact_view_revision_org_status` ON `artifact_view_revision` (`organization_id`,`build_status`);--> statement-breakpoint
CREATE INDEX `artifact_view_org_script` ON `artifact_view` (`organization_id`,`config_object_id`);--> statement-breakpoint
CREATE INDEX `artifact_view_org_owner` ON `artifact_view` (`organization_id`,`owner_member_id`);--> statement-breakpoint
CREATE INDEX `artifact_view_active_revision` ON `artifact_view` (`active_revision_id`);