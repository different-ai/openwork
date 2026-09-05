CREATE TABLE `org_cloud_trials` (
	`organization_id` varchar(64) NOT NULL,
	`started_by_user_id` varchar(64) NOT NULL,
	`started_at` timestamp(3) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`ending_sent_at` timestamp(3),
	`expired_sent_at` timestamp(3),
	`notification_lease_until` timestamp(3),
	`notification_lease_token` varchar(64),
	CONSTRAINT `org_cloud_trials_organization_id` PRIMARY KEY(`organization_id`),
	CONSTRAINT `org_cloud_trials_starter` UNIQUE(`started_by_user_id`)
);
--> statement-breakpoint
CREATE INDEX `org_cloud_trials_expiry` ON `org_cloud_trials` (`expires_at`);