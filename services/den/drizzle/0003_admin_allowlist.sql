CREATE TABLE `admin_allowlist` (
  `id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `note` varchar(255),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `admin_allowlist_id` PRIMARY KEY(`id`),
  CONSTRAINT `admin_allowlist_email` UNIQUE(`email`)
);

INSERT INTO `admin_allowlist` (`id`, `email`, `note`)
VALUES
  ('admin-ben-openworklabs-com', 'ben@openworklabs.com', 'Seeded internal admin'),
  ('admin-jan-openworklabs-com', 'jan@openworklabs.com', 'Seeded internal admin'),
  ('admin-omar-openworklabs-com', 'omar@openworklabs.com', 'Seeded internal admin'),
  ('admin-berk-openworklabs-com', 'berk@openworklabs.com', 'Seeded internal admin')
ON DUPLICATE KEY UPDATE
  `note` = VALUES(`note`),
  `updated_at` = CURRENT_TIMESTAMP(3);
