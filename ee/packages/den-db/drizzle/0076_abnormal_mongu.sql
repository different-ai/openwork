RENAME TABLE `codemode_run` TO `workflow_run`;--> statement-breakpoint
DROP INDEX `codemode_run_org_created` ON `workflow_run`;--> statement-breakpoint
DROP INDEX `codemode_run_automation` ON `workflow_run`;--> statement-breakpoint
DROP INDEX `codemode_run_artifact_history` ON `workflow_run`;--> statement-breakpoint
ALTER TABLE `config_object` MODIFY COLUMN `object_type` enum('skill','agent','command','tool','mcp','hook','context','custom','script','workflow','app') NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_mapping` MODIFY COLUMN `object_type` enum('skill','agent','command','tool','mcp','hook','context','custom','script','workflow','app') NOT NULL;--> statement-breakpoint
UPDATE `config_object` SET `object_type` = 'workflow' WHERE `object_type` = 'script';--> statement-breakpoint
UPDATE `connector_mapping` SET `object_type` = 'workflow' WHERE `object_type` = 'script';--> statement-breakpoint
ALTER TABLE `config_object` MODIFY COLUMN `object_type` enum('skill','agent','command','tool','mcp','hook','context','custom','script','workflow','app') NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_mapping` MODIFY COLUMN `object_type` enum('skill','agent','command','tool','mcp','hook','context','custom','script','workflow','app') NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_run_org_created` ON `workflow_run` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_run_automation` ON `workflow_run` (`automation_run_id`);--> statement-breakpoint
CREATE INDEX `workflow_run_artifact_history` ON `workflow_run` (`config_object_id`,`finished_at`);
