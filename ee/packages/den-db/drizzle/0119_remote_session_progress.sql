ALTER TABLE `remote_session_command` ADD `session_status` enum('running','waiting','idle','error');--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_waiting_for` enum('permission','question');--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_engine` enum('v1','v2');--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_model_provider_id` varchar(160);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_model_model_id` varchar(160);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_model_variant` varchar(60);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_final_text` mediumtext;--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_error_code` varchar(60);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_error_message` varchar(2000);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_message_count` int;--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_observed_at` timestamp(3);