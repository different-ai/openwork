ALTER TABLE `remote_device` ADD `label_chosen_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `computer_command` ADD `call` json;--> statement-breakpoint
ALTER TABLE `computer_grant` ADD `writable_folders` json;