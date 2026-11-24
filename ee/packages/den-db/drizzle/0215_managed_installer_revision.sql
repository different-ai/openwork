ALTER TABLE `managed_deployment_run` ADD `installer_revision` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `managed_deployment` ADD `installed_installer_revision` int;