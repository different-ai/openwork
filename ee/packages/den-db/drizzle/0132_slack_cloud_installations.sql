CREATE TABLE `slack_installation` (
	`client_id` varchar(512) NOT NULL,
	`workspace_id` varchar(64) NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` timestamp(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_installation_client_id_workspace_id_pk` PRIMARY KEY(`client_id`,`workspace_id`)
);
