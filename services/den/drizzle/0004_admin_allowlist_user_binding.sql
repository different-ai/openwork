ALTER TABLE `admin_allowlist` ADD `user_id` varchar(64);
CREATE UNIQUE INDEX `admin_allowlist_user_id` ON `admin_allowlist` (`user_id`);
