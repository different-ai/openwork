CREATE TABLE `personal_agent_chat_turn` (
	`id` varchar(64) NOT NULL,
	`conversation_id` varchar(64) NOT NULL,
	`client_message_id` varchar(128) NOT NULL,
	`message` mediumtext NOT NULL,
	`reply` mediumtext,
	`status` enum('running','succeeded','failed') NOT NULL,
	`error` varchar(160),
	`finished_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_chat_turn_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_chat_turn_client_message` UNIQUE(`conversation_id`,`client_message_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_conversation` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_conversation_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_conversation_member` UNIQUE(`organization_id`,`agent_id`,`member_id`)
);
--> statement-breakpoint
ALTER TABLE `tool_approval` ADD `chat_turn_id` varchar(64);--> statement-breakpoint
CREATE INDEX `personal_agent_chat_turn_status` ON `personal_agent_chat_turn` (`conversation_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `personal_agent_chat_turn_history` ON `personal_agent_chat_turn` (`conversation_id`,`created_at`,`id`);