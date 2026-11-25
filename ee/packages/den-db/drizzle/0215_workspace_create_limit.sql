CREATE TABLE `workspace_create_identity` (
	`identity` varchar(320) NOT NULL,
	CONSTRAINT `workspace_create_identity_identity` PRIMARY KEY(`identity`)
);
--> statement-breakpoint
CREATE TABLE `workspace_create_limit_rule` (
	`scope` enum('email','domain') NOT NULL,
	`value` varchar(320) NOT NULL,
	`workspace_limit` int,
	`set_by_user_id` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `workspace_create_limit_rule_scope_value_pk` PRIMARY KEY(`scope`,`value`)
);
