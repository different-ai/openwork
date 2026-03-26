CREATE TABLE IF NOT EXISTS `temp_template_sharing` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `creator_member_id` varchar(64) NOT NULL,
  `creator_user_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `template_json` text NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `temp_template_sharing_id` PRIMARY KEY(`id`),
  KEY `temp_template_sharing_org_id` (`organization_id`),
  KEY `temp_template_sharing_creator_member_id` (`creator_member_id`),
  KEY `temp_template_sharing_creator_user_id` (`creator_user_id`)
);
