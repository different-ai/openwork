CREATE TABLE `funded_model_suspension` (
	`reference_hash` varchar(64) NOT NULL,
	`provider_reference` varchar(128) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`suspended_by` varchar(64) NOT NULL,
	`suspended_at` timestamp(3) NOT NULL DEFAULT (now()),
	`released_at` timestamp(3),
	`released_by` varchar(64),
	`release_reference` varchar(128),
	CONSTRAINT `funded_model_suspension_reference_hash` PRIMARY KEY(`reference_hash`)
);
--> statement-breakpoint
ALTER TABLE `sandbox_organization` ADD `sponsored_set_id` varchar(64);--> statement-breakpoint
CREATE INDEX `funded_model_suspension_user` ON `funded_model_suspension` (`user_id`,`released_at`);