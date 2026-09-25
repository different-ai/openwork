CREATE TABLE `audit_operation_step` (
	`organization_id` varchar(64) NOT NULL,
	`operation_id` varchar(64) NOT NULL,
	`step_hash` char(64) NOT NULL,
	`workflow_step` varchar(128) NOT NULL,
	`step_scope` varchar(512) NOT NULL,
	`request_id` varchar(128) NOT NULL,
	CONSTRAINT `audit_operation_step_pk` PRIMARY KEY(`organization_id`,`operation_id`,`step_hash`)
);
