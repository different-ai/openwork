CREATE TABLE `daytona_sandbox` (
  `id` varchar(64) NOT NULL,
  `worker_id` varchar(64) NOT NULL,
  `sandbox_id` varchar(128) NOT NULL,
  `workspace_volume_id` varchar(128) NOT NULL,
  `data_volume_id` varchar(128) NOT NULL,
  `signed_preview_url` varchar(2048) NOT NULL,
  `signed_preview_url_expires_at` timestamp(3) NOT NULL,
  `region` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `daytona_sandbox_id` PRIMARY KEY(`id`),
  CONSTRAINT `daytona_sandbox_worker_id` UNIQUE(`worker_id`),
  CONSTRAINT `daytona_sandbox_sandbox_id` UNIQUE(`sandbox_id`)
);
