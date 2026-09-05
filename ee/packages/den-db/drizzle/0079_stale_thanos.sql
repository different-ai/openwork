CREATE TABLE `llm_provider_member_credential` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`llm_provider_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`secret` text NOT NULL,
	`external_principal_id` varchar(255),
	`external_credential_id` varchar(255),
	`state` enum('active','blocked','stale','error') NOT NULL DEFAULT 'active',
	`version` int NOT NULL DEFAULT 1,
	`created_by` enum('member','admin','provisioner') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `llm_provider_member_credential_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_provider_member_credential_member_provider` UNIQUE(`org_membership_id`,`llm_provider_id`)
);
--> statement-breakpoint
ALTER TABLE `llm_provider` ADD `credential_mode` enum('shared','per_member') DEFAULT 'shared' NOT NULL;--> statement-breakpoint
CREATE INDEX `llm_provider_member_credential_organization_id` ON `llm_provider_member_credential` (`organization_id`);