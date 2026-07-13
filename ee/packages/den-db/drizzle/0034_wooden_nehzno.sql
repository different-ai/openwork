ALTER TABLE `desktop_policy` ADD `priority` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `desktop_policy_priority` ON `desktop_policy` (`priority`);