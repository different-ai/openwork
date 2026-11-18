CREATE TABLE `managed_deployment_aws_sign_in` (
	`org_id` varchar(64) NOT NULL,
	`portal_url` varchar(300) NOT NULL,
	`role_name` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `managed_deployment_aws_sign_in_org_id` PRIMARY KEY(`org_id`)
);
