CREATE TABLE `organization_diagnostic_credential` (
	`organization_id` varchar(64) NOT NULL,
	`bearer_token` text NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `organization_diagnostic_credential_organization_id` PRIMARY KEY(`organization_id`)
);
