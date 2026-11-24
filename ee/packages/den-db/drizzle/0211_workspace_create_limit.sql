CREATE TABLE `workspace_create_limit_override` (
	`user_id` varchar(64) NOT NULL,
	`workspace_limit` int,
	`set_by_user_id` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `workspace_create_limit_override_user_id` PRIMARY KEY(`user_id`)
);
