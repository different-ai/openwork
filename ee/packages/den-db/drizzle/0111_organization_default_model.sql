CREATE TABLE `organization_default_model` (
	`organization_id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`updated_by_org_member_id` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `organization_default_model_organization_id` PRIMARY KEY(`organization_id`)
);
