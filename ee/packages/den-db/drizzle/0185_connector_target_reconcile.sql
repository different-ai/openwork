-- GitHub reconcile schedule moves out of connector_target.target_config_json
-- into its own small table, so the scheduled reconcile pages through due
-- targets on an index instead of loading and sorting every target's config.
-- Plain DDL only (PlanetScale/Vitess). Rows are seeded by den-api in small
-- batches on each run, carrying any state found in the old JSON key.
CREATE TABLE `connector_target_reconcile` (
	`connector_target_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`connector_type` enum('github') NOT NULL,
	`status` enum('ok','retrying','paused') NOT NULL DEFAULT 'ok',
	`next_probe_at` timestamp(3),
	`last_probed_at` timestamp(3),
	`failure_count` int NOT NULL DEFAULT 0,
	`error` varchar(1024),
	`paused_revision_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `connector_target_reconcile_connector_target_id` PRIMARY KEY(`connector_target_id`)
);
--> statement-breakpoint
CREATE INDEX `connector_target_reconcile_type_next_probe` ON `connector_target_reconcile` (`connector_type`,`next_probe_at`,`connector_target_id`);--> statement-breakpoint
CREATE INDEX `connector_target_reconcile_type_status` ON `connector_target_reconcile` (`connector_type`,`status`);--> statement-breakpoint
CREATE INDEX `connector_target_reconcile_organization_id` ON `connector_target_reconcile` (`organization_id`);