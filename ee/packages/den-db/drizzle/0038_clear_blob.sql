CREATE INDEX `user_created_at_id` ON `user` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `invitation_inviter_id` ON `invitation` (`inviter_id`);--> statement-breakpoint
CREATE INDEX `organization_created_at_id` ON `organization` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `telemetry_event_member_ts` ON `telemetry_event` (`member_id`,`event_timestamp`);