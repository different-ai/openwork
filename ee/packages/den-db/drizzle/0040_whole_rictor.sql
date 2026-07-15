CREATE TABLE `organization_admission_policy` (
	`organization_id` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`admission_methods` json NOT NULL,
	`email_domain_mode` varchar(32) NOT NULL DEFAULT 'any',
	`allowed_email_domains` json NOT NULL,
	`authentication_requirement` varchar(32) NOT NULL DEFAULT 'any',
	`lifecycle_authority` varchar(32) NOT NULL DEFAULT 'local',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `organization_admission_policy_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
INSERT INTO `organization_admission_policy` (
	`organization_id`,
	`version`,
	`admission_methods`,
	`email_domain_mode`,
	`allowed_email_domains`,
	`authentication_requirement`,
	`lifecycle_authority`
)
SELECT
	o.`id`,
	1,
	CASE
		WHEN EXISTS (SELECT 1 FROM `sso_connection` s WHERE s.`organization_id` = o.`id`)
			AND EXISTS (SELECT 1 FROM `scim_provider` p WHERE p.`organization_id` = o.`id`)
			THEN JSON_ARRAY('invitation', 'sso_jit', 'scim')
		WHEN EXISTS (SELECT 1 FROM `sso_connection` s WHERE s.`organization_id` = o.`id`)
			THEN JSON_ARRAY('invitation', 'sso_jit')
		WHEN EXISTS (SELECT 1 FROM `scim_provider` p WHERE p.`organization_id` = o.`id`)
			THEN JSON_ARRAY('invitation', 'scim')
		ELSE JSON_ARRAY('invitation')
	END,
	CASE
		WHEN o.`allowed_email_domains` IS NOT NULL AND JSON_LENGTH(o.`allowed_email_domains`) > 0
			THEN 'allowlist'
		ELSE 'any'
	END,
	COALESCE(o.`allowed_email_domains`, JSON_ARRAY()),
	CASE
		WHEN JSON_UNQUOTE(JSON_EXTRACT(o.`metadata`, '$.requireSso')) = 'true'
			THEN 'organization_sso'
		ELSE 'any'
	END,
	'local'
FROM `organization` o;
--> statement-breakpoint
ALTER TABLE `session` ADD `authentication_method` varchar(32);--> statement-breakpoint
ALTER TABLE `session` ADD `authentication_provider_id` varchar(255);--> statement-breakpoint
ALTER TABLE `session` ADD `authentication_organization_id` varchar(64);--> statement-breakpoint
ALTER TABLE `session` ADD `authenticated_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `invitation` ADD `invite_token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `member` ADD `admission_source` varchar(32);--> statement-breakpoint
ALTER TABLE `member` ADD `admission_policy_version` int;--> statement-breakpoint
ALTER TABLE `member` ADD `admitted_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `member` ADD `removal_source` varchar(32);--> statement-breakpoint
UPDATE `member`
SET
	`admission_source` = 'legacy',
	`admission_policy_version` = 1,
	`admitted_at` = COALESCE(`joined_at`, `created_at`)
WHERE `user_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `invitation`
SET
	`invite_token_hash` = SHA2(COALESCE(`invite_token`, `id`), 256);
--> statement-breakpoint
ALTER TABLE `invitation` DROP INDEX `invitation_invite_token`;
--> statement-breakpoint
ALTER TABLE `invitation` DROP COLUMN `invite_token`;
--> statement-breakpoint
ALTER TABLE `invitation` ADD CONSTRAINT `invitation_invite_token_hash` UNIQUE(`invite_token_hash`);--> statement-breakpoint
CREATE INDEX `organization_admission_policy_updated_at` ON `organization_admission_policy` (`updated_at`);
