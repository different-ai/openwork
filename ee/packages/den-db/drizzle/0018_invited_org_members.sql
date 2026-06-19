ALTER TABLE `member` MODIFY COLUMN `user_id` varchar(64);
--> statement-breakpoint
ALTER TABLE `member` ADD `invite_id` varchar(64);
--> statement-breakpoint
ALTER TABLE `member` ADD `invited_by_org_member` varchar(64);
--> statement-breakpoint
ALTER TABLE `member` ADD `joined_at` timestamp(3) NULL DEFAULT (now());
--> statement-breakpoint
UPDATE `member` SET `joined_at` = `created_at` WHERE `joined_at` IS NULL;
--> statement-breakpoint
ALTER TABLE `member` ADD `removed_at` timestamp(3);
--> statement-breakpoint
ALTER TABLE `member` ADD `removed_by_org_member` varchar(64);
--> statement-breakpoint
ALTER TABLE `invitation` ADD `org_member_id` varchar(64);
--> statement-breakpoint
ALTER TABLE `invitation` ADD `invite_token` varchar(64);
--> statement-breakpoint
CREATE INDEX `member_invite_id` ON `member` (`invite_id`);
--> statement-breakpoint
CREATE INDEX `member_invited_by_org_member` ON `member` (`invited_by_org_member`);
--> statement-breakpoint
CREATE INDEX `member_removed_at` ON `member` (`removed_at`);
--> statement-breakpoint
CREATE INDEX `member_removed_by_org_member` ON `member` (`removed_by_org_member`);
--> statement-breakpoint
CREATE INDEX `invitation_org_member_id` ON `invitation` (`org_member_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_invite_token` ON `invitation` (`invite_token`);
