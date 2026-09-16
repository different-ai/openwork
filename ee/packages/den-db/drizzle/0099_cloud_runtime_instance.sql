CREATE TABLE `cloud_runtime_instance` (
	`id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`provider_id` varchar(64) NOT NULL,
	`provider_ref` json NOT NULL,
	`workspace_volume_id` varchar(128) NOT NULL,
	`data_volume_id` varchar(128) NOT NULL,
	`endpoint_url` varchar(2048) NOT NULL,
	`endpoint_expires_at` timestamp(3) NOT NULL,
	`endpoint_kind` varchar(32) NOT NULL,
	`region` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_runtime_instance_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_runtime_instance_worker_id` UNIQUE(`worker_id`)
);
--> statement-breakpoint
CREATE INDEX `cloud_runtime_instance_provider` ON `cloud_runtime_instance` (`provider_id`);
--> statement-breakpoint
INSERT INTO `cloud_runtime_instance` (`id`, `worker_id`, `provider_id`, `provider_ref`, `workspace_volume_id`, `data_volume_id`, `endpoint_url`, `endpoint_expires_at`, `endpoint_kind`, `region`, `created_at`, `updated_at`)
SELECT CONCAT('cri_', SUBSTRING(`id`, 5)), `worker_id`, 'daytona', JSON_OBJECT('sandboxId', `sandbox_id`), `workspace_volume_id`, `data_volume_id`, `signed_preview_url`, `signed_preview_url_expires_at`, 'signed-expiring', `region`, `created_at`, `updated_at`
FROM `daytona_sandbox`;
