ALTER TABLE `mcp_diagnostic_attempt` ADD `completion_audit_event_id` varchar(64);--> statement-breakpoint
ALTER TABLE `mcp_diagnostic_attempt` ADD `execution_lease_id` varchar(64);--> statement-breakpoint
ALTER TABLE `mcp_diagnostic_attempt` ADD `execution_lease_expires_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_attempt_org_status_member` ON `mcp_diagnostic_attempt` (`organization_id`,`status`,`created_by_org_membership_id`);--> statement-breakpoint
CREATE INDEX `mcp_diagnostic_attempt_org_started_member` ON `mcp_diagnostic_attempt` (`organization_id`,`started_at`,`created_by_org_membership_id`);