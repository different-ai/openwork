ALTER TABLE `remote_device` ADD `machine_key` varchar(64);--> statement-breakpoint
ALTER TABLE `computer_grant` ADD `revoked_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `computer_grant` ADD `revoked_by_member_id` varchar(64);--> statement-breakpoint
CREATE INDEX `remote_device_owner_machine` ON `remote_device` (`organization_id`,`owner_member_id`,`machine_key`);