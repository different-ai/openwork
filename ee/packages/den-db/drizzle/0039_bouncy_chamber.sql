CREATE TABLE `desktop_connect_grant` (
	`code_hash` varchar(64) NOT NULL,
	`install_link_id` varchar(64) NOT NULL,
	`claims` json NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`consumed_at` timestamp(3),
	`consumed_nonce` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `desktop_connect_grant_code_hash` PRIMARY KEY(`code_hash`)
);
--> statement-breakpoint
CREATE INDEX `desktop_connect_grant_install_link_id` ON `desktop_connect_grant` (`install_link_id`);--> statement-breakpoint
CREATE INDEX `desktop_connect_grant_expires_at` ON `desktop_connect_grant` (`expires_at`);