CREATE TABLE `dashboard_app` (
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`artifact_view_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `dashboard_app_organization_id_member_id_artifact_view_id_pk` PRIMARY KEY(`organization_id`,`member_id`,`artifact_view_id`)
);
